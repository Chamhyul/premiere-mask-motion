#include "clipboard.hpp"
#include "../bridge-protocol.hpp"
#include <shlobj.h>
#include <sddl.h>
#include <aclapi.h>
#include <filesystem>
#include <fstream>
#include <memory>
#include <chrono>
#include <adobesdk/AdobesdkStringSuite.h>
#include <adobesdk/controlsurface/plugin/ControlSurfacePluginSuite.h>
#include <adobesdk/controlsurface/plugin/ControlSurfaceCommandSuite.h>
#include <adobesdk/controlsurface/host/ControlSurfaceHostSuite.h>
#include <adobesdk/controlsurface/host/ControlSurfaceHostCommandSuite.h>
#if !defined(_M_X64)
#error Mask Tracker requires the x64 MSVC toolchain.
#endif

namespace {
namespace fs=std::filesystem;
using namespace masktracker;
HINSTANCE instance=nullptr;HWND window=nullptr;fs::path directory;
SPBasicSuite* basic=nullptr;const SPSuitesSuite* suites=nullptr;SPSuiteListRef suiteList=nullptr;
const ADOBESDK_StringSuite1* strings=nullptr;
const ADOBESDK_ControlSurfaceHostSuite1* host=nullptr;
const ADOBESDK_ControlSurfaceHostCommandSuite1* commands=nullptr;
ADOBESDK_ControlSurfaceHostCommandRef commandRef=nullptr;
ADOBESDK_String copyID{},copyContext{};bool copyAvailable=false;
std::string session;int token=0;double lastReady=0;
bool polling=false;
constexpr wchar_t className[]=L"MaskTrackerClipboardBridgeV1";
double now(){return double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());}
std::string utf8String(const std::wstring& s){
  if(s.empty())return {};int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0,nullptr,nullptr);
  if(!n)throw std::runtime_error("invalid Windows text");std::string out(size_t(n),'\0');WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),int(s.size()),out.data(),n,nullptr,nullptr);return out;
}
std::string sdkString(const ADOBESDK_String& value){uint32_t n=0;strings->CopyToUTF8String(&value,nullptr,&n);if(!n||n>1048576)return {};std::vector<ADOBESDK_UTF8Char> bytes(n);if(strings->CopyToUTF8String(&value,bytes.data(),&n))return {};return std::string(reinterpret_cast<char*>(bytes.data()));}
SPErr outString(const char* value,ADOBESDK_String* out){return strings->AllocateFromUTF8(reinterpret_cast<const ADOBESDK_UTF8Char*>(value),out);}
void writeJSON(const std::string& name,const std::string& json){
  fs::path path=directory/fs::u8path(name),tmp=directory/fs::u8path(name+".tmp-"+session);
  {std::ofstream file(tmp,std::ios::binary|std::ios::trunc);file.write(json.data(),std::streamsize(json.size()));file.flush();if(!file)throw std::runtime_error("bridge write failed");}
  if(!MoveFileExW(tmp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("bridge replace failed");
}
bool privateDirectory(const fs::path& path,PSID user,PSECURITY_DESCRIPTOR security){
  SECURITY_ATTRIBUTES sa{sizeof(sa),security,FALSE};
  if(!CreateDirectoryW(path.c_str(),&sa)&&GetLastError()!=ERROR_ALREADY_EXISTS)return false;
  DWORD attributes=GetFileAttributesW(path.c_str());if(attributes==INVALID_FILE_ATTRIBUTES||!(attributes&FILE_ATTRIBUTE_DIRECTORY)||(attributes&FILE_ATTRIBUTE_REPARSE_POINT))return false;
  PSID owner=nullptr;PSECURITY_DESCRIPTOR actual=nullptr;
  if(GetNamedSecurityInfoW(const_cast<wchar_t*>(path.c_str()),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,nullptr,nullptr,nullptr,&actual)!=ERROR_SUCCESS)return false;
  bool ours=EqualSid(user,owner)!=FALSE;LocalFree(actual);if(!ours)return false;
  PACL acl=nullptr;BOOL present=FALSE,defaulted=FALSE;if(!GetSecurityDescriptorDacl(security,&present,&acl,&defaulted)||!present)return false;
  return SetNamedSecurityInfoW(const_cast<wchar_t*>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,acl,nullptr)==ERROR_SUCCESS;
}
bool prepareDirectory(){
  HANDLE processToken=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&processToken))return false;
  DWORD size=0;GetTokenInformation(processToken,TokenUser,nullptr,0,&size);std::vector<uint8_t> bytes(size);
  bool got=GetTokenInformation(processToken,TokenUser,bytes.data(),size,&size)!=FALSE;CloseHandle(processToken);if(!got)return false;
  PSID sid=reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid;LPWSTR sidText=nullptr;if(!ConvertSidToStringSidW(sid,&sidText))return false;
  std::wstring sddl=L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;"+std::wstring(sidText)+L")";LocalFree(sidText);
  PSECURITY_DESCRIPTOR security=nullptr;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&security,nullptr))return false;
  PWSTR profile=nullptr;HRESULT hr=SHGetKnownFolderPath(FOLDERID_Profile,0,nullptr,&profile);
  bool ok=false;if(SUCCEEDED(hr)){fs::path root=fs::path(profile)/L".mask-tracker";directory=root/L"bridge";ok=privateDirectory(root,sid,security)&&privateDirectory(directory,sid,security);CoTaskMemFree(profile);}
  LocalFree(security);return ok;
}
struct Job {
  Request request;win::Snapshot backup;enum Phase {Snapshot,WaitCopy,Restore} phase=Snapshot;
  DWORD before=0,commandSequence=0,ownedSequence=0;SPErr error=0;
  double copyDeadline=0;std::string xml,formats;bool reported=false;
};
std::unique_ptr<Job> job;
void ready(){writeJSON("ready.json","{\"protocol\":1,\"session\":"+quote(session)+",\"platform\":\"win32\",\"pid\":"+std::to_string(GetCurrentProcessId())+",\"copyAvailable\":"+(copyAvailable&&!(job&&job->reported)?"true":"false")+",\"updatedAt\":"+std::to_string(static_cast<int64_t>(now()))+"}");}
void reply(bool ok,bool restored,bool verified,const std::string& message){
  if(!job||job->reported)return;
  writeJSON("result-"+job->request.id+".json","{\"id\":"+quote(job->request.id)+",\"session\":"+quote(session)+",\"ok\":"+(ok?"true":"false")+
    ",\"clipboardRestored\":"+(restored?"true":"false")+",\"clipboardVerified\":"+(verified?"true":"false")+
    ",\"format\":\"com.adobe.dvaui.pproae/exchange/trackitem\",\"xml\":"+quote(ok?job->xml:"")+",\"message\":"+quote(message)+",\"copiedFormats\":"+(job->formats.empty()?"[]":job->formats)+"}");
  job->reported=true;
}
bool ownerIsPremiere(){DWORD pid=0;HWND owner=GetClipboardOwner();if(owner)GetWindowThreadProcessId(owner,&pid);return pid==GetCurrentProcessId();}
void readCopiedXML(){
  job->formats="[";bool comma=false;UINT format=0;unsigned count=0;
  while((format=EnumClipboardFormats(format))!=0 && count++<512){
    wchar_t name[512]{};GetClipboardFormatNameW(format,name,512);
    std::string label=name[0]?utf8String(name):std::to_string(format);
    size_t size=0;try{if(win::baseFormat(format)!=CF_BITMAP&&win::baseFormat(format)!=CF_PALETTE&&win::baseFormat(format)!=CF_METAFILEPICT&&win::baseFormat(format)!=CF_ENHMETAFILE){auto bytes=win::globalBytes(GetClipboardData(format));size=bytes.size();if(job->xml.empty())job->xml=clipboardXML(bytes);}}catch(...){/* GDI or non-memory formats are not XML. */}
    if(comma)job->formats+=",";comma=true;job->formats+="{\"name\":"+quote(label)+",\"bytes\":"+std::to_string(size)+"}";
  }job->formats+="]";
}
void advanceJob(){
  if(!job)return;
  if(job->phase==Job::Snapshot){
    if(now()>job->request.deadline){reply(false,true,true,"클립보드가 사용 중입니다. 클립을 다시 선택하세요.");job.reset();return;}
    {win::ClipboardLock lock(window);if(!lock.open)return;
      try{job->backup=win::snapshot();job->before=GetClipboardSequenceNumber();}
      catch(...){reply(false,true,true,"클립보드를 보존할 수 없어 마스크 읽기를 중단했습니다.");job.reset();return;}}
    if(GetClipboardSequenceNumber()!=job->before){reply(false,false,false,"클립보드가 변경되었습니다. 클립을 다시 선택하세요.");job.reset();return;}
    job->phase=Job::WaitCopy;job->copyDeadline=now()+1000;
    job->error=commands->ExecuteCommand(commandRef,&copyContext,&copyID);
    job->commandSequence=GetClipboardSequenceNumber();
  }
  if(job->phase==Job::WaitCopy){
    DWORD sequence=GetClipboardSequenceNumber();
    if(sequence==job->before&&!job->error&&now()<job->copyDeadline)return;
    win::ClipboardLock lock(window);if(!lock.open)return;sequence=GetClipboardSequenceNumber();
    if(sequence==job->before){bool intact=win::equals(job->backup);reply(false,intact,intact,"타임라인에서 비디오 클립을 다시 선택하세요.");job.reset();return;}
    if((job->commandSequence!=job->before&&sequence!=job->commandSequence)||!ownerIsPremiere()){
      reply(false,false,false,"다른 복사 작업이 감지되었습니다. 새 클립보드 내용을 유지했습니다.");job.reset();return;
    }
    job->ownedSequence=sequence;
    try{if(!job->error)readCopiedXML();}catch(...){job->xml.clear();}
    // Delayed rendering may run during GetClipboardData. Never overwrite a new
    // clipboard generation that was not part of our captured Copy transaction.
    if(GetClipboardSequenceNumber()!=job->ownedSequence){reply(false,false,false,"클립보드가 변경되었습니다. 새 내용을 유지했습니다.");job.reset();return;}
    job->phase=Job::Restore;
  }
  if(job->phase==Job::Restore){
    win::ClipboardLock lock(window);if(!lock.open)return;
    if(GetClipboardSequenceNumber()!=job->ownedSequence){reply(false,false,false,"클립보드가 변경되었습니다. 새 내용을 유지했습니다.");job.reset();return;}
    bool restored=win::restore(job->backup,job->ownedSequence),verified=restored&&win::equals(job->backup);
    if(!verified){
      // Keep backup handles in memory and keep retrying. Never start another
      // copy while a failed restoration still needs the user's original data.
      if(now()>job->request.deadline)reply(false,false,false,"클립보드 복원을 기다리고 있습니다. 다른 복사 작업을 잠시 멈춰 주세요.");
      return;
    }
    bool ok=!job->error&&!job->xml.empty();reply(ok,true,true,ok?"":"Windows 복사 데이터를 읽지 못했습니다. 타임라인에서 클립을 다시 선택하세요.");job.reset();
  }
}
void poll(){
  if(now()-lastReady>1000){ready();lastReady=now();}
  if(job){advanceJob();return;}if(!copyAvailable)return;
  for(const auto& entry:fs::directory_iterator(directory)){
    std::string name=entry.path().filename().u8string();
    if(name.rfind("request-",0)!=0||name.size()<14||name.substr(name.size()-5)!=".json")continue;
    DWORD attr=GetFileAttributesW(entry.path().c_str());if(attr==INVALID_FILE_ATTRIBUTES||(attr&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)))continue;
    if(entry.file_size()>65536)continue;
    std::ifstream input(entry.path(),std::ios::binary);std::string data(65537,'\0');input.read(data.data(),std::streamsize(data.size()));data.resize(size_t(input.gcount()));if(data.size()>65536||input.bad())continue;
    // Windows does not allow deletion while this stream holds the file open.
    // Release it before claiming the request by removing its file.
    input.close();
    Request r;try{r=masktracker::request(data,name,session,now());}catch(...){continue;}
    std::error_code ec;fs::remove(entry.path(),ec);if(ec)continue;
    job=std::make_unique<Job>();job->request=std::move(r);advanceJob();break;
  }
}
LRESULT CALLBACK procedure(HWND hwnd,UINT message,WPARAM wp,LPARAM lp){
  if(message==WM_TIMER){if(polling)return 0;polling=true;try{poll();}catch(...){/* Keep any in-flight clipboard backup alive for the next tick. */}polling=false;return 0;}
  return DefWindowProcW(hwnd,message,wp,lp);
}
void findCopy(){
  if(copyAvailable)return;uint32_t count=0;if(commands->GetCommandCount(commandRef,&count))return;
  for(uint32_t i=0;i<count;i++){ADOBESDK_String context{},contextName{},id{},name{};if(commands->GetCommand(commandRef,i,&context,&contextName,&id,&name))continue;
    bool match=sdkString(id)=="cmd.edit.copy"&&sdkString(context)=="global";strings->DisposeString(&contextName);strings->DisposeString(&name);
    if(match){copyContext=context;copyID=id;copyAvailable=true;break;}strings->DisposeString(&context);strings->DisposeString(&id);}
}
SPErr connect(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_ControlSurfaceHostRef ref,ADOBESDK_ControlSurfaceRef* out){
  if(job)return kSPBadParameterError;SPErr e=host->GetCommandRef(ref,&commandRef);if(e)return e;
  try{if(!prepareDirectory())return kSPBadParameterError;GUID guid{};if(FAILED(CoCreateGuid(&guid)))return kSPBadParameterError;wchar_t text[40]{};StringFromGUID2(guid,text,40);session=utf8String(text);
    WNDCLASSEXW c{};c.cbSize=sizeof(c);c.lpfnWndProc=procedure;c.hInstance=instance;c.lpszClassName=className;
    if(!RegisterClassExW(&c)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)return kSPBadParameterError;
    window=CreateWindowExW(0,className,L"",0,0,0,0,0,HWND_MESSAGE,nullptr,instance,nullptr);if(!window)return kSPBadParameterError;
    findCopy();ready();if(!SetTimer(window,1,80,nullptr)){DestroyWindow(window);window=nullptr;return kSPBadParameterError;}
    *out=reinterpret_cast<ADOBESDK_ControlSurfaceRef>(&token);return kSPNoError;
  }catch(...){if(window){DestroyWindow(window);window=nullptr;}return kSPBadParameterError;}
}
SPErr disconnect(ADOBESDK_ControlSurfacePluginRef){
  if(job&&job->phase==Job::Restore){win::ClipboardLock lock(window);if(lock.open&&win::restore(job->backup,job->ownedSequence))job.reset();}
  if(job&&job->phase!=Job::Snapshot)return kSPBadParameterError;
  job.reset();if(window){KillTimer(window,1);DestroyWindow(window);window=nullptr;}
  UnregisterClassW(className,instance);
  if(copyAvailable){strings->DisposeString(&copyContext);strings->DisposeString(&copyID);}copyAvailable=false;commandRef=nullptr;return kSPNoError;
}
SPErr pluginID(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_String* s){return outString("com.local.premiere.masktracker.clipboard",s);}
SPErr pluginName(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_String* s){return outString("Mask Tracker",s);}
SPErr getSettings(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_String* s){return outString("",s);}
SPErr setSettings(ADOBESDK_ControlSurfacePluginRef,const ADOBESDK_String*){return kSPNoError;}
SPErr hasDialog(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_Boolean* b){*b=0;return kSPNoError;}
SPErr runDialog(ADOBESDK_ControlSurfacePluginRef,void*,ADOBESDK_Boolean* b){*b=0;return kSPNoError;}
SPErr noop(ADOBESDK_ControlSurfacePluginRef){return kSPNoError;}
ADOBESDK_ControlSurfacePluginSuite1 pluginSuite={connect,disconnect,pluginID,pluginName,getSettings,setSettings,hasDialog,runDialog,noop,noop};
SPErr config(ADOBESDK_ControlSurfaceRef,ADOBESDK_String* s){return outString("com.local.premiere.masktracker.clipboard",s);}
SPErr flags(ADOBESDK_ControlSurfaceRef,uint32_t* f){*f=1;return kSPNoError;}
template<class T>SPErr noRef(ADOBESDK_ControlSurfaceRef,T* out){*out=nullptr;return kSPNoError;}
SPErr commandOut(ADOBESDK_ControlSurfaceRef,ADOBESDK_ControlSurfaceCommandRef* out){*out=reinterpret_cast<ADOBESDK_ControlSurfaceCommandRef>(&token);return kSPNoError;}
SPErr buttonCount(ADOBESDK_ControlSurfaceCommandRef,uint32_t* n){*n=0;return kSPNoError;}
ADOBESDK_ControlSurfaceCommandSuite1 buttonSuite={buttonCount,nullptr,nullptr,nullptr,nullptr};
SPErr update(ADOBESDK_ControlSurfaceRef){return kSPNoError;}
ADOBESDK_ControlSurfaceSuite2 surfaceSuite={config,flags,noRef<ADOBESDK_ControlSurfaceTransportRef>,noRef<ADOBESDK_ControlSurfaceMixerRef>,noRef<ADOBESDK_ControlSurfaceMarkerRef>,commandOut,update,noRef<ADOBESDK_ControlSurfaceLumetriRef>};
SPErr startup(){SPErr e=basic->AcquireSuite(kADOBESDK_StringSuite,1,reinterpret_cast<const void**>(&strings));if(e)return e;
  e=basic->AcquireSuite(kADOBESDK_ControlSurfaceHostSuite,1,reinterpret_cast<const void**>(&host));if(e)return e;
  e=basic->AcquireSuite(kADOBESDK_ControlSurfaceHostCommandSuite,1,reinterpret_cast<const void**>(&commands));if(e)return e;
  e=basic->AcquireSuite(kSPSuitesSuite,kSPSuitesSuiteVersion,reinterpret_cast<const void**>(&suites));if(e)return e;
  e=suites->AllocateSuiteList(kSPRuntimeStringPool,kSPRuntimePluginList,&suiteList);if(e)return e;SPSuiteRef r=nullptr;
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfacePluginSuite,1,1,&pluginSuite,&r);
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfaceSuite,1,1,&surfaceSuite,&r);
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfaceSuite,2,2,&surfaceSuite,&r);
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfaceCommandSuite,1,1,&buttonSuite,&r);return kSPNoError;
}
SPErr shutdown(){return disconnect(nullptr);}
SPErr create(ADOBESDK_ControlSurfacePluginRef* out){*out=reinterpret_cast<ADOBESDK_ControlSurfacePluginRef>(&token);return kSPNoError;}
SPErr destroy(ADOBESDK_ControlSurfacePluginRef){return kSPNoError;}
SPErr getSuiteList(SPSuiteListRef* out){*out=suiteList;return kSPNoError;}
} // namespace
extern "C" __declspec(dllexport) SPErr EntryPoint(SPBasicSuite* b,uint32_t,uint32_t,ADOBESDK_ControlSurfaceHostID,ADOBESDK_ControlSurfacePluginFuncs* out){basic=b;*out={startup,shutdown,create,destroy,getSuiteList};return b?kSPNoError:kSPBadParameterError;}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){instance=module;DisableThreadLibraryCalls(module);}return TRUE;}
