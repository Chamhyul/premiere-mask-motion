// Windows-only registration helper. Runs as the original, unelevated desktop user.
// Premiere's private XML format is validated before changing any existing file.
#include <windows.h>
#include <shlobj.h>
#include <tlhelp32.h>
#include <msxml6.h>
#include <wrl/client.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;
using Node = ComPtr<IXMLDOMNode>;
static const wchar_t* PluginID = L"com.local.premiere.masktracker.clipboard";
static void Check(HRESULT hr) { if (FAILED(hr)) throw std::runtime_error("Windows XML/API operation failed"); }
static void Require(bool okay, const char* message) { if (!okay) throw std::runtime_error(message); }
struct BStr {
    BSTR value;
    explicit BStr(const wchar_t* s): value(SysAllocString(s)) { Require(value != nullptr, "Out of memory"); }
    explicit BStr(const std::wstring& s): BStr(s.c_str()) {}
    ~BStr() { SysFreeString(value); }
    operator BSTR() const { return value; }
};
static std::wstring Text(IXMLDOMNode* n) {
    BSTR s = nullptr; Check(n->get_text(&s));
    std::wstring result(s ? s : L""); SysFreeString(s); return result;
}
static std::wstring Name(IXMLDOMNode* n) {
    BSTR s = nullptr; Check(n->get_nodeName(&s));
    std::wstring result(s ? s : L""); SysFreeString(s); return result;
}
static std::vector<Node> Children(IXMLDOMNode* n) {
    ComPtr<IXMLDOMNodeList> list; Check(n->get_childNodes(&list));
    long length = 0; Check(list->get_length(&length)); std::vector<Node> result;
    for (long i = 0; i < length; ++i) {
        Node child; Check(list->get_item(i, &child)); DOMNodeType type;
        Check(child->get_nodeType(&type)); if (type == NODE_ELEMENT) result.push_back(child);
    }
    return result;
}
static Node One(IXMLDOMNode* n, const wchar_t* name) {
    Node result;
    for (const auto& child : Children(n)) if (Name(child.Get()) == name) {
        Require(!result, "Duplicate XML element"); result = child;
    }
    Require(result != nullptr, "Unsupported XML structure"); return result;
}
static std::map<std::wstring, Node> Pairs(IXMLDOMNode* list) {
    std::map<std::wstring, Node> result;
    for (const auto& entry : Children(list)) {
        Require(Name(entry.Get()) == L"prop.pair" && Children(entry.Get()).size() == 2, "Unsupported setting entry");
        const auto key = Text(One(entry.Get(), L"key").Get());
        Require(!key.empty() && result.emplace(key, entry).second, "Duplicate or empty setting key");
    }
    return result;
}
static Node Element(IXMLDOMDocument2* doc, const wchar_t* name, const std::wstring* text = nullptr) {
    ComPtr<IXMLDOMElement> e; Check(doc->createElement(BStr(name), &e));
    if (text) Check(e->put_text(BStr(*text)));
    Node n; Check(e.As(&n)); return n;
}
static void Append(IXMLDOMNode* parent, IXMLDOMNode* child) {
    Node added; Check(parent->appendChild(child, &added));
}
static void Attribute(IXMLDOMNode* n, const wchar_t* key, const wchar_t* value) {
    ComPtr<IXMLDOMElement> e; Check(n->QueryInterface(IID_PPV_ARGS(&e)));
    VARIANT v; VariantInit(&v); v.vt = VT_BSTR; v.bstrVal = SysAllocString(value);
    Require(v.bstrVal != nullptr, "Out of memory");
    HRESULT hr = e->setAttribute(BStr(key), v); VariantClear(&v); Check(hr);
}
static void AddEntry(IXMLDOMDocument2* doc, IXMLDOMNode* list, const std::wstring& key, IXMLDOMNode* value) {
    Node entry = Element(doc, L"prop.pair"); Node k = Element(doc, L"key", &key);
    Append(entry.Get(), k.Get()); Append(entry.Get(), value); Append(list, entry.Get());
}
static Node Group(IXMLDOMDocument2* doc, IXMLDOMNode* list, const std::wstring& key, bool& changed) {
    auto pairs = Pairs(list); auto found = pairs.find(key);
    if (found != pairs.end()) return One(found->second.Get(), L"prop.list");
    Node value = Element(doc, L"prop.list"); AddEntry(doc, list, key, value.Get()); changed = true; return value;
}
static void SetString(IXMLDOMDocument2* doc, IXMLDOMNode* list, const std::wstring& key, const std::wstring& value, bool& changed) {
    auto pairs = Pairs(list); auto found = pairs.find(key);
    if (found != pairs.end()) {
        Node text = One(found->second.Get(), L"ustring");
        if (Text(text.Get()) != value) { Check(text->put_text(BStr(value))); changed = true; }
    } else {
        Node text = Element(doc, L"ustring", &value); AddEntry(doc, list, key, text.Get()); changed = true;
    }
}
static bool Running() {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    Require(snapshot != INVALID_HANDLE_VALUE, "Cannot check Premiere process state");
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    BOOL more = Process32FirstW(snapshot, &entry); bool found = false;
    if (!more && GetLastError() != ERROR_NO_MORE_FILES) { CloseHandle(snapshot); throw std::runtime_error("Cannot enumerate processes"); }
    while (more) {
        if (_wcsicmp(entry.szExeFile, L"Adobe Premiere Pro.exe") == 0 || _wcsicmp(entry.szExeFile, L"PremierePro.exe") == 0) found = true;
        more = Process32NextW(snapshot, &entry);
    }
    const DWORD error = GetLastError(); CloseHandle(snapshot);
    Require(error == ERROR_NO_MORE_FILES, "Incomplete process enumeration"); return found;
}
static void CheckUser() {
    HANDLE token = nullptr; Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != 0, "Cannot inspect user token");
    TOKEN_ELEVATION elevation{}; DWORD size = 0;
    BOOL okay = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size); CloseHandle(token);
    Require(okay && !elevation.TokenIsElevated, "Run the installer normally, not with Run as administrator; registration needs the original user");
}
static fs::path KnownFolder(REFKNOWNFOLDERID id) {
    PWSTR raw = nullptr; Check(SHGetKnownFolderPath(id, 0, nullptr, &raw));
    fs::path result(raw); CoTaskMemFree(raw); return result;
}
static void SafePath(const fs::path& path) {
    Require(path.is_absolute(), "Absolute paths required");
    for (fs::path part = path; !part.empty(); part = part.parent_path()) {
        DWORD attrs = GetFileAttributesW(part.c_str());
        if (attrs != INVALID_FILE_ATTRIBUTES) Require(!(attrs & FILE_ATTRIBUTE_REPARSE_POINT), "Reparse-point settings paths are not modified");
        else Require(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND, "Cannot inspect settings path");
        if (part == part.root_path()) break;
    }
}
static std::string Read(const fs::path& path) {
    const auto size = fs::file_size(path); Require(size <= 4 * 1024 * 1024, "Settings file exceeds 4 MB");
    std::ifstream stream(path, std::ios::binary); Require(stream.good(), "Cannot read settings");
    std::string bytes(static_cast<size_t>(size), '\0');
    if (size) stream.read(bytes.data(), static_cast<std::streamsize>(size));
    Require(!stream.fail(), "Incomplete settings read"); return bytes;
}
static std::wstring Guid() {
    GUID id; Check(CoCreateGuid(&id)); wchar_t text[40]{};
    Require(StringFromGUID2(id, text, 40) > 0, "Cannot create temporary name"); return text;
}
struct TempFile { fs::path path; ~TempFile() { if (!path.empty()) DeleteFileW(path.c_str()); } };
static std::wstring Register(const fs::path& path, const fs::path& module) {
    SafePath(path); bool exists = fs::exists(path); std::string before;
    ComPtr<IXMLDOMDocument2> doc;
    Check(CoCreateInstance(__uuidof(DOMDocument60), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&doc)));
    Check(doc->put_async(VARIANT_FALSE)); Check(doc->put_validateOnParse(VARIANT_FALSE));
    Check(doc->put_resolveExternals(VARIANT_FALSE)); Check(doc->put_preserveWhiteSpace(VARIANT_TRUE));
    VARIANT prohibit; VariantInit(&prohibit); prohibit.vt = VT_BOOL; prohibit.boolVal = VARIANT_TRUE;
    Check(doc->setProperty(BStr(L"ProhibitDTD"), prohibit));
    bool changed = !exists;
    if (exists) {
        Require(fs::is_regular_file(path), "Settings is not a regular file"); before = Read(path);
        VARIANT source; VariantInit(&source); source.vt = VT_BSTR; source.bstrVal = SysAllocString(path.c_str());
        Require(source.bstrVal != nullptr, "Out of memory"); VARIANT_BOOL loaded = VARIANT_FALSE;
        HRESULT hr = doc->load(source, &loaded); VariantClear(&source); Check(hr);
        Require(loaded == VARIANT_TRUE, "Invalid settings XML or prohibited DTD");
        Require(Read(path) == before, "Settings changed during read");
    } else {
        VARIANT_BOOL loaded = VARIANT_FALSE;
        Check(doc->loadXML(BStr(L"<?xml version=\"1.0\"?><prop.map version=\"4\"><prop.list/></prop.map>"), &loaded));
        Require(loaded == VARIANT_TRUE, "Cannot initialize settings XML");
    }
    ComPtr<IXMLDOMElement> root; Check(doc->get_documentElement(&root));
    Require(root && Name(root.Get()) == L"prop.map", "Unsupported settings root");
    VARIANT version; VariantInit(&version); Check(root->getAttribute(BStr(L"version"), &version));
    const bool supported = version.vt == VT_BSTR && std::wstring(version.bstrVal) == L"4";
    VariantClear(&version); Require(supported, "Unsupported settings version");
    Node top = One(root.Get(), L"prop.list");
    Node active = Group(doc.Get(), top.Get(), L"ActivePluginIDs", changed); auto ids = Pairs(active.Get()); bool found = false;
    for (const auto& pair : ids) if (Text(One(pair.second.Get(), L"ustring").Get()) == PluginID) found = true;
    if (!found) {
        size_t i = 0; while (ids.count(L"PluginID" + std::to_wstring(i))) ++i;
        SetString(doc.Get(), active.Get(), L"PluginID" + std::to_wstring(i), PluginID, changed);
    }
    Node catalog = Group(doc.Get(), top.Get(), L"PluginList", changed);
    // Windows path keys are case-insensitive; retain an existing equivalent key.
    std::wstring moduleKey = module.wstring();
    for (const auto& pair : Pairs(catalog.Get())) {
        std::wstring normalized = pair.first; for (auto& c : normalized) if (c == L'/') c = L'\\';
        if (_wcsicmp(normalized.c_str(), module.c_str()) == 0) moduleKey = pair.first;
    }
    Node own = Group(doc.Get(), catalog.Get(), moduleKey, changed); auto fields = Pairs(own.Get());
    auto id = fields.find(L"ID");
    if (id != fields.end()) Require(Text(One(id->second.Get(), L"ustring").Get()) == PluginID, "Module path belongs to another device");
    SetString(doc.Get(), own.Get(), L"ID", PluginID, changed);
    SetString(doc.Get(), own.Get(), L"Name", L"Mask Tracker", changed);
    Node settings = Group(doc.Get(), top.Get(), L"PluginSettingsList", changed);
    Group(doc.Get(), settings.Get(), PluginID, changed);
    if (!Pairs(top.Get()).count(L"SettingsVersion")) {
        std::wstring one = L"1"; Node number = Element(doc.Get(), L"int", &one);
        Attribute(number.Get(), L"type", L"unsigned"); Attribute(number.Get(), L"size", L"32");
        AddEntry(doc.Get(), top.Get(), L"SettingsVersion", number.Get()); changed = true;
    }
    if (!changed) return L"already_registered";
    fs::create_directories(path.parent_path()); SafePath(path);
    TempFile temporary{path.parent_path() / (L".mask-tracker-register-" + Guid() + L".xml")};
    // Reserve the temporary name before MSXML writes it.
    HANDLE handle = CreateFileW(temporary.path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    Require(handle != INVALID_HANDLE_VALUE, "Cannot create temporary settings file"); CloseHandle(handle);
    VARIANT destination; VariantInit(&destination); destination.vt = VT_BSTR; destination.bstrVal = SysAllocString(temporary.path.c_str());
    Require(destination.bstrVal != nullptr, "Out of memory"); HRESULT hr = doc->save(destination); VariantClear(&destination); Check(hr);
    handle = CreateFileW(temporary.path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    Require(handle != INVALID_HANDLE_VALUE, "Cannot flush settings"); BOOL flushed = FlushFileBuffers(handle); CloseHandle(handle);
    Require(flushed != 0, "Cannot flush settings");
    Require(!Running(), "Quit Premiere before registering"); SafePath(path);
    if (exists) {
        Require(fs::exists(path) && Read(path) == before, "Settings changed; registration stopped");
        fs::path backup = path.wstring() + L".mask-tracker-backup-" + Guid();
        Require(CopyFileW(path.c_str(), backup.c_str(), TRUE) != 0, "Cannot back up settings");
        Require(Read(backup) == before && Read(path) == before, "Settings changed during backup");
        // Preserve destination ACLs; do not ignore ACL merge errors.
        Require(ReplaceFileW(path.c_str(), temporary.path.c_str(), nullptr, 0, nullptr, nullptr) != 0, "Cannot replace settings; backup retained");
    } else {
        Require(!fs::exists(path), "Settings appeared; registration stopped");
        Require(MoveFileExW(temporary.path.c_str(), path.c_str(), MOVEFILE_WRITE_THROUGH) != 0, "Cannot create settings");
    }
    return L"registered";
}
int wmain(int argc, wchar_t** argv) {
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) return 1;
    int result = 0;
    try {
        CheckUser(); Require(!Running(), "Quit Premiere before registering");
        fs::path module = KnownFolder(FOLDERID_ProgramFilesX64) / L"Adobe/Common/Plug-ins/ControlSurface/MaskTrackerClipboard.acsrf";
        std::set<fs::path> paths;
        if ((argc == 3 || argc == 5) && std::wstring(argv[1]) == L"--settings-file") {
            paths.insert(fs::path(argv[2]));
            if (argc == 5) {
                Require(std::wstring(argv[3]) == L"--module-path", "Invalid arguments");
                module = fs::path(argv[4]); Require(module.is_absolute(), "Absolute module path required");
            }
        }
        else if (argc == 1) {
            const fs::path prefs = KnownFolder(FOLDERID_RoamingAppData) / L"Adobe/Premiere Pro";
            SafePath(prefs);
            if (fs::exists(prefs)) for (const auto& entry : fs::directory_iterator(prefs))
                if (entry.is_directory() && std::regex_match(entry.path().filename().wstring(), std::wregex(L"[0-9]+\\.[0-9]+")))
                    paths.insert(entry.path() / L"ControlSurface/ControlSurfaceSettings.xml");
            Require(!paths.empty(), "Launch Premiere once, quit it, then run this installer again");
        } else throw std::runtime_error("Invalid arguments");
        Require(fs::is_regular_file(module), "Installed MaskTrackerClipboard.acsrf is missing");
        for (const auto& path : paths) std::wcout << Register(path, module) << L"\t" << path.wstring() << L"\n";
    } catch (const std::exception& error) {
        std::cerr << "Mask Tracker registration: " << error.what() << " (Windows error " << GetLastError() << ")\n";
        result = 1;
    }
    CoUninitialize(); return result;
}
