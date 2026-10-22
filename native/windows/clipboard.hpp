#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <ole2.h>
#include <vector>
#include <string>
#include <utility>
#include <stdexcept>
#include <algorithm>
#include <cstring>
#include <cstdint>

namespace masktracker::win {
constexpr size_t maxClipboard=256u*1024u*1024u;
inline UINT baseFormat(UINT f){
  if(f==CF_DSPBITMAP)return CF_BITMAP;
  if(f==CF_DSPMETAFILEPICT)return CF_METAFILEPICT;
  if(f==CF_DSPENHMETAFILE)return CF_ENHMETAFILE;
  return f;
}
inline void freeData(UINT format,HANDLE h){
  if(!h)return;
  switch(baseFormat(format)){
    case CF_BITMAP:case CF_PALETTE:DeleteObject(h);break;
    case CF_ENHMETAFILE:DeleteEnhMetaFile(static_cast<HENHMETAFILE>(h));break;
    case CF_METAFILEPICT:{auto p=static_cast<METAFILEPICT*>(GlobalLock(h));if(p){DeleteMetaFile(p->hMF);GlobalUnlock(h);}GlobalFree(h);break;}
    default:GlobalFree(h);
  }
}
struct Data {
  UINT format=0;HANDLE handle=nullptr;
  Data()=default;Data(UINT f,HANDLE h):format(f),handle(h){}
  Data(const Data&)=delete;Data& operator=(const Data&)=delete;
  Data(Data&& d)noexcept:format(d.format),handle(std::exchange(d.handle,nullptr)){}
  Data& operator=(Data&& d)noexcept{if(this!=&d){freeData(format,handle);format=d.format;handle=std::exchange(d.handle,nullptr);}return *this;}
  ~Data(){freeData(format,handle);}
  HANDLE release(){return std::exchange(handle,nullptr);}
};
inline Data duplicate(UINT format,HANDLE h){
  UINT base=baseFormat(format);
  // Private application-owned pointers and display callbacks cannot be safely
  // serialized. Refuse the transaction before issuing Premiere's Copy.
  if(!h||format==CF_OWNERDISPLAY||(format>=CF_PRIVATEFIRST&&format<=CF_PRIVATELAST))throw std::runtime_error("unsupported clipboard ownership");
  HANDLE copy=base==CF_ENHMETAFILE?static_cast<HANDLE>(CopyEnhMetaFileW(static_cast<HENHMETAFILE>(h),nullptr)):
    OleDuplicateData(h,static_cast<CLIPFORMAT>(base),GMEM_MOVEABLE);
  if(!copy)throw std::runtime_error("clipboard duplicate failed");return Data(format,copy);
}
template<class T> inline void append(std::vector<uint8_t>& b,const T& v){auto p=reinterpret_cast<const uint8_t*>(&v);b.insert(b.end(),p,p+sizeof(v));}
inline std::vector<uint8_t> globalBytes(HANDLE h){
  SIZE_T n=GlobalSize(h);if(!n||n>maxClipboard)throw std::runtime_error("clipboard memory size");
  auto p=static_cast<const uint8_t*>(GlobalLock(h));if(!p)throw std::runtime_error("clipboard memory lock");
  std::vector<uint8_t> out;try{out.assign(p,p+n);}catch(...){GlobalUnlock(h);throw;}GlobalUnlock(h);return out;
}
inline std::vector<uint8_t> contents(UINT format,HANDLE h){
  std::vector<uint8_t> out;
  switch(baseFormat(format)){
    case CF_BITMAP:{
      BITMAP bm{};if(!GetObjectW(h,sizeof(bm),&bm)||bm.bmWidth<=0||bm.bmHeight<=0||uint64_t(bm.bmWidth)*bm.bmHeight>maxClipboard/4)throw std::runtime_error("bitmap size");
      BITMAPINFO info{};info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);info.bmiHeader.biWidth=bm.bmWidth;info.bmiHeader.biHeight=bm.bmHeight;
      info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;info.bmiHeader.biCompression=BI_RGB;
      std::vector<uint8_t> pixels(size_t(bm.bmWidth)*size_t(bm.bmHeight)*4);
      HDC dc=CreateCompatibleDC(nullptr);if(!dc)throw std::runtime_error("bitmap DC");
      int rows=GetDIBits(dc,static_cast<HBITMAP>(h),0,UINT(bm.bmHeight),pixels.data(),&info,DIB_RGB_COLORS);DeleteDC(dc);
      if(rows!=bm.bmHeight)throw std::runtime_error("bitmap read");
      append(out,bm.bmWidth);append(out,bm.bmHeight);append(out,bm.bmPlanes);append(out,bm.bmBitsPixel);out.insert(out.end(),pixels.begin(),pixels.end());return out;
    }
    case CF_PALETTE:{UINT n=GetPaletteEntries(static_cast<HPALETTE>(h),0,0,nullptr);if(!n||n>65536)throw std::runtime_error("palette size");std::vector<PALETTEENTRY> entries(n);if(GetPaletteEntries(static_cast<HPALETTE>(h),0,n,entries.data())!=n)throw std::runtime_error("palette read");append(out,n);auto p=reinterpret_cast<uint8_t*>(entries.data());out.insert(out.end(),p,p+n*sizeof(PALETTEENTRY));return out;}
    case CF_ENHMETAFILE:{UINT n=GetEnhMetaFileBits(static_cast<HENHMETAFILE>(h),0,nullptr);if(!n||n>maxClipboard)throw std::runtime_error("enhanced metafile size");out.resize(n);if(GetEnhMetaFileBits(static_cast<HENHMETAFILE>(h),n,out.data())!=n)throw std::runtime_error("enhanced metafile read");return out;}
    case CF_METAFILEPICT:{auto p=static_cast<METAFILEPICT*>(GlobalLock(h));if(!p)throw std::runtime_error("metafile lock");METAFILEPICT m=*p;GlobalUnlock(h);UINT n=GetMetaFileBitsEx(m.hMF,0,nullptr);if(!n||n>maxClipboard)throw std::runtime_error("metafile size");append(out,m.mm);append(out,m.xExt);append(out,m.yExt);size_t prefix=out.size();out.resize(prefix+n);if(GetMetaFileBitsEx(m.hMF,n,out.data()+prefix)!=n)throw std::runtime_error("metafile read");return out;}
    default:return globalBytes(h);
  }
}
struct Entry {UINT format;Data data;std::vector<uint8_t> bytes;};
using Snapshot=std::vector<Entry>;
// All functions below require an already-open clipboard. No snapshot bytes are
// written to disk. Keep the snapshot alive until restoration has been verified.
inline Snapshot snapshot(){
  Snapshot result;size_t total=0;UINT f=0;
  while(true){SetLastError(ERROR_SUCCESS);f=EnumClipboardFormats(f);if(!f){if(GetLastError()!=ERROR_SUCCESS)throw std::runtime_error("clipboard enumeration");break;}
    if(result.size()>=512)throw std::runtime_error("clipboard format count");
    if(f==CF_OWNERDISPLAY||(f>=CF_PRIVATEFIRST&&f<=CF_PRIVATELAST))throw std::runtime_error("unsupported clipboard ownership");
    HANDLE original=GetClipboardData(f);if(!original)throw std::runtime_error("clipboard delayed rendering");
    auto bytes=contents(f,original);if(bytes.size()>maxClipboard-total)throw std::runtime_error("clipboard size");total+=bytes.size();
    Data copy=duplicate(f,original);if(contents(f,copy.handle)!=bytes)throw std::runtime_error("clipboard clone mismatch");
    result.push_back({f,std::move(copy),std::move(bytes)});
  }return result;
}
inline bool equals(const Snapshot& before){
  try{std::vector<UINT> formats;UINT f=0;while(true){SetLastError(ERROR_SUCCESS);f=EnumClipboardFormats(f);if(!f){if(GetLastError())return false;break;}formats.push_back(f);}
    // Windows can synthesize equivalent text/bitmap formats. Require every
    // original representation byte-for-byte; do not reject OS-added formats.
    if(before.empty())return formats.empty();
    for(const auto& e:before)if(std::find(formats.begin(),formats.end(),e.format)==formats.end()||contents(e.format,GetClipboardData(e.format))!=e.bytes)return false;
    return true;
  }catch(...){return false;}
}
inline bool restore(const Snapshot& before,DWORD& ownedSequence){
  if(GetClipboardSequenceNumber()!=ownedSequence)return false;
  if(equals(before))return true;
  // Allocate every replacement before emptying the clipboard. Retain the backup
  // handles after SetClipboardData transfers ownership of replacement handles.
  std::vector<Data> replacements;try{for(const auto& e:before)replacements.push_back(duplicate(e.format,e.data.handle));}catch(...){return false;}
  if(!EmptyClipboard())return false;
  ownedSequence=GetClipboardSequenceNumber();
  for(auto& data:replacements){if(!SetClipboardData(data.format,data.handle)){ownedSequence=GetClipboardSequenceNumber();return false;}data.release();}
  ownedSequence=GetClipboardSequenceNumber();return equals(before);
}
struct ClipboardLock {bool open;explicit ClipboardLock(HWND owner):open(OpenClipboard(owner)!=FALSE){}~ClipboardLock(){if(open)CloseClipboard();}};
} // namespace masktracker::win
