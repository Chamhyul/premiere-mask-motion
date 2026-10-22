// Read-only diagnostic: format names and sizes, never clipboard payloads.
#include "clipboard.hpp"
#include <cstdio>
#include <wincrypt.h>
std::wstring digest(const std::vector<uint8_t>& bytes){
 HCRYPTPROV provider=0;HCRYPTHASH hash=0;std::wstring out=L"unavailable";
 if(CryptAcquireContextW(&provider,nullptr,nullptr,PROV_RSA_AES,CRYPT_VERIFYCONTEXT)){
  if(CryptCreateHash(provider,CALG_SHA_256,0,0,&hash)){
   if(CryptHashData(hash,bytes.data(),DWORD(bytes.size()),0)){
    BYTE value[32]{};DWORD n=sizeof(value);if(CryptGetHashParam(hash,HP_HASHVAL,value,&n,0)){out.clear();for(DWORD i=0;i<n;i++){wchar_t hex[3]{};swprintf_s(hex,3,L"%02x",unsigned(value[i]));out+=hex;}}
   }CryptDestroyHash(hash);
  }CryptReleaseContext(provider,0);
 }return out;
}
int wmain(){
  masktracker::win::ClipboardLock lock(nullptr);if(!lock.open){std::fputs("Clipboard is busy.\n",stderr);return 1;}
  UINT f=0;
  while((f=EnumClipboardFormats(f))!=0){
    wchar_t name[512]{};GetClipboardFormatNameW(f,name,512);
    std::wprintf(L"format=%u name=%ls",f,name[0]?name:L"(standard)");
    try{auto bytes=masktracker::win::contents(f,GetClipboardData(f));std::wprintf(L" bytes=%zu sha256=%ls\n",bytes.size(),digest(bytes).c_str());}catch(...){std::wprintf(L" bytes=(not readable)\n");}
  }
  try{auto snapshot=masktracker::win::snapshot();if(!masktracker::win::equals(snapshot))throw std::runtime_error("changed");std::puts("Snapshot cloning and equality: PASS (clipboard was not changed)");}
  catch(...){std::puts("Snapshot cloning: unsupported clipboard format; plugin will refuse Copy before changing it.");return 2;}
  return 0;
}
