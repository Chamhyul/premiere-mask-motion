#include "bridge-protocol.hpp"
#include <cassert>
#include <iostream>
using namespace masktracker;
template<class F>void rejects(F f){bool caught=false;try{f();}catch(...){caught=true;}assert(caught);}
std::vector<uint8_t> bytes(const std::string& s){return {s.begin(),s.end()};}
int main(){
 std::string json=R"({"protocol":1,"id":"abc-123","session":"s","operation":"copyMask","deadline":2000,"source":{"name":"비디오","nested":[null,true,false,1.25]}})";
 auto r=request(json,"request-abc-123.json","s",1000);assert(r.id=="abc-123");
 rejects([&]{request(json,"request-wrong.json","s",1000);});
 rejects([&]{request(json,"request-abc-123.json","other",1000);});
 rejects([&]{request(json,"request-abc-123.json","s",2001);});
 rejects([&]{Parser(R"({"id":"a","id":"b"})").object();});
 rejects([&]{Parser(R"({"a":"\ud800"})").object();});
 rejects([&]{Parser(R"({"a":01})").object();});
 assert(Parser(R"({"a":"\ud83d\ude00"})").object()["a"].text=="\xf0\x9f\x98\x80");
 assert(quote("a\n\"b")=="\"a\\u000a\\\"b\"");
 std::string xml="<PremiereData Version=\"1\"><VideoClipTrackItem/></PremiereData>";
 assert(clipboardXML(bytes(xml))==xml);
 assert(clipboardXML(bytes("\xef\xbb\xbf<?xml version=\"1.0\"?>\n"+xml+std::string(4,'\0')))==xml);
 for(bool le:{true,false}){std::vector<uint8_t> b=le?std::vector<uint8_t>{255,254}:std::vector<uint8_t>{254,255};for(uint8_t c:xml){b.push_back(le?c:0);b.push_back(le?0:c);}assert(clipboardXML(b)==xml);}
 assert(clipboardXML(bytes("binary-prefix"+xml)).empty());
 assert(clipboardXML(bytes("<PremiereData><VideoClipTrackItem/></PremiereData>garbage")).empty());
 assert(clipboardXML(bytes("<PremiereData><MasterClip/></PremiereData>")).empty());
 assert(clipboardXML(bytes("<!DOCTYPE x>"+xml)).empty());
 assert(!validUTF8(std::string("\xc0\xaf",2)));
 std::cout<<"bridge protocol: request validation, Unicode, XML UTF-8/UTF-16, payload rejection passed\n";
}
