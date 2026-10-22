#pragma once
#include <string>
#include <vector>
#include <map>
#include <set>
#include <stdexcept>
#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <algorithm>

namespace masktracker {
inline void utf8(std::string& out,uint32_t cp) {
  if(cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))throw std::runtime_error("invalid Unicode");
  if(cp<0x80)out+=char(cp);
  else if(cp<0x800){out+=char(0xc0|(cp>>6));out+=char(0x80|(cp&63));}
  else if(cp<0x10000){out+=char(0xe0|(cp>>12));out+=char(0x80|((cp>>6)&63));out+=char(0x80|(cp&63));}
  else{out+=char(0xf0|(cp>>18));out+=char(0x80|((cp>>12)&63));out+=char(0x80|((cp>>6)&63));out+=char(0x80|(cp&63));}
}
inline bool validUTF8(const std::string& s) {
  size_t i=0;while(i<s.size()){
    uint8_t a=uint8_t(s[i++]);uint32_t cp=a,min=0;int n=0;
    if(a<128)continue;
    if(a>=194&&a<=223){n=1;cp=a&31;min=128;}
    else if(a>=224&&a<=239){n=2;cp=a&15;min=2048;}
    else if(a>=240&&a<=244){n=3;cp=a&7;min=65536;}else return false;
    for(int j=0;j<n;j++){if(i>=s.size()||(uint8_t(s[i])&192)!=128)return false;cp=(cp<<6)|(uint8_t(s[i++])&63);}
    if(cp<min||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))return false;
  }return true;
}
inline std::string quote(const std::string& s) {
  static const char hex[]="0123456789abcdef";std::string out="\"";
  for(uint8_t c:s){if(c=='"'||c=='\\'){out+='\\';out+=char(c);}else if(c<32){out+="\\u00";out+=hex[c>>4];out+=hex[c&15];}else out+=char(c);}
  return out+'"';
}
struct Value {char type=0;std::string text;double number=0;};
class Parser {
  const std::string& s;size_t pos=0;
  [[noreturn]] void fail(){throw std::runtime_error("invalid request JSON");}
  void ws(){while(pos<s.size()&&(s[pos]==' '||s[pos]=='\r'||s[pos]=='\n'||s[pos]=='\t'))pos++;}
  uint32_t hex4(){uint32_t n=0;for(int i=0;i<4;i++){if(pos>=s.size())fail();char c=s[pos++];int v=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1;if(v<0)fail();n=n*16+v;}return n;}
  std::string string(){
    if(pos>=s.size()||s[pos++]!='"')fail();std::string out;
    while(pos<s.size()){
      uint8_t c=uint8_t(s[pos++]);if(c=='"')return out;if(c<32)fail();if(c!='\\'){out+=char(c);continue;}
      if(pos>=s.size())fail();char e=s[pos++];
      if(e=='"'||e=='\\'||e=='/')out+=e;
      else if(e=='b')out+='\b';else if(e=='f')out+='\f';else if(e=='n')out+='\n';else if(e=='r')out+='\r';else if(e=='t')out+='\t';
      else if(e=='u'){uint32_t cp=hex4();if(cp>=0xd800&&cp<=0xdbff){if(s.compare(pos,2,"\\u"))fail();pos+=2;uint32_t low=hex4();if(low<0xdc00||low>0xdfff)fail();cp=0x10000+((cp-0xd800)<<10)+low-0xdc00;}utf8(out,cp);}else fail();
    }fail();
  }
  Value value(unsigned depth,std::map<std::string,Value>* fields=nullptr){
    if(depth>16)fail();ws();if(pos>=s.size())fail();char c=s[pos];
    if(c=='"')return {'s',string(),0};
    if(c=='{'||c=='['){bool object=c=='{';char end=object?'}':']';pos++;ws();std::set<std::string> keys;
      if(pos<s.size()&&s[pos]==end){pos++;return {c,"",0};}
      while(true){std::string key;if(object){ws();key=string();if(!keys.insert(key).second)fail();ws();if(pos>=s.size()||s[pos++]!=':')fail();}
        Value v=value(depth+1);if(fields&&object)(*fields)[key]=v;ws();if(pos>=s.size())fail();char next=s[pos++];if(next==end)break;if(next!=',')fail();
      }return {c,"",0};
    }
    for(const char* token:{"true","false","null"}){size_t n=std::char_traits<char>::length(token);if(s.compare(pos,n,token)==0){pos+=n;return {'b',token,0};}}
    size_t start=pos;if(s[pos]=='-')pos++;if(pos>=s.size())fail();
    if(s[pos]=='0')pos++;else {if(s[pos]<'1'||s[pos]>'9')fail();while(pos<s.size()&&s[pos]>='0'&&s[pos]<='9')pos++;}
    if(pos<s.size()&&s[pos]=='.'){pos++;size_t p=pos;while(pos<s.size()&&s[pos]>='0'&&s[pos]<='9')pos++;if(p==pos)fail();}
    if(pos<s.size()&&(s[pos]=='e'||s[pos]=='E')){pos++;if(pos<s.size()&&(s[pos]=='+'||s[pos]=='-'))pos++;size_t p=pos;while(pos<s.size()&&s[pos]>='0'&&s[pos]<='9')pos++;if(p==pos)fail();}
    std::string num=s.substr(start,pos-start);double n=std::strtod(num.c_str(),nullptr);if(!std::isfinite(n))fail();return {'n',num,n};
  }
public:
  explicit Parser(const std::string& input):s(input){}
  std::map<std::string,Value> object(){if(s.size()>65536||!validUTF8(s))fail();std::map<std::string,Value> fields;Value v=value(0,&fields);ws();if(v.type!='{'||pos!=s.size())fail();return fields;}
};
struct Request {std::string id,session;double deadline=0;};
inline Request request(const std::string& json,const std::string& filename,const std::string& session,double now){
  auto f=Parser(json).object();Request r;
  for(auto key:{"id","session","operation"})if(f[key].type!='s')throw std::runtime_error("missing string");
  r.id=f["id"].text;r.session=f["session"].text;r.deadline=f["deadline"].number;
  if(r.id.empty()||r.id.size()>80||r.id.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-")!=std::string::npos||
    filename!="request-"+r.id+".json"||r.session!=session||f["operation"].text!="copyMask"||f["protocol"].type!='n'||f["protocol"].number!=1||
    f["deadline"].type!='n'||r.deadline<now||r.deadline>now+10000)throw std::runtime_error("invalid request envelope");
  return r;
}
// Windows registered format names are host-dependent. Accept only a complete,
// bounded PremiereData XML payload, not an arbitrary substring or binary wrapper.
inline std::string clipboardXML(const std::vector<uint8_t>& b){
  if(b.empty()||b.size()>64*1024*1024)return {};
  std::string s;
  try{
    bool le=(b.size()>=2&&b[0]==0xff&&b[1]==0xfe)||(b.size()>=4&&b[0]=='<'&&b[1]==0);
    bool be=(b.size()>=2&&b[0]==0xfe&&b[1]==0xff)||(b.size()>=4&&b[0]==0&&b[1]=='<');
    if(le||be){if(b.size()%2)return {};size_t i=(b[0]==0xff||b[0]==0xfe)?2:0;
      while(i<b.size()){auto word=[&](size_t p){return uint32_t(le?b[p]|(b[p+1]<<8):(b[p]<<8)|b[p+1]);};uint32_t cp=word(i);i+=2;
        if(cp>=0xd800&&cp<=0xdbff){if(i+1>=b.size())return {};uint32_t low=word(i);i+=2;if(low<0xdc00||low>0xdfff)return {};cp=0x10000+((cp-0xd800)<<10)+low-0xdc00;}utf8(s,cp);}
    }else{s.assign(b.begin(),b.end());if(s.compare(0,3,"\xef\xbb\xbf")==0)s.erase(0,3);}
  }catch(...){return {};}
  while(!s.empty()&&(s.back()==0||s.back()==' '||s.back()=='\r'||s.back()=='\n'||s.back()=='\t'))s.pop_back();
  size_t first=s.find_first_not_of(" \r\n\t");if(first==std::string::npos)return {};s.erase(0,first);
  if(s.compare(0,5,"<?xml")==0){size_t end=s.find("?>");if(end==std::string::npos)return {};s.erase(0,end+2);first=s.find_first_not_of(" \r\n\t");if(first==std::string::npos)return {};s.erase(0,first);}
  if(s.size()>32*1024*1024||!validUTF8(s)||s.find('\0')!=std::string::npos||s.compare(0,13,"<PremiereData")!=0||
    s.size()<15||s.compare(s.size()-15,15,"</PremiereData>")!=0||s.find("<VideoClipTrackItem")==std::string::npos||s.find("<!DOCTYPE")!=std::string::npos||s.find("<!ENTITY")!=std::string::npos)return {};
  return s;
}
} // namespace masktracker
