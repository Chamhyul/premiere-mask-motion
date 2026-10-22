#import <AppKit/AppKit.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

static NSString *const PluginID=@"com.local.premiere.masktracker.clipboard";
static NSString *const ModulePath=@"/Library/Application Support/Adobe/Common/Plug-ins/ControlSurface/MaskTrackerClipboard.bundle";
static void Fail(NSString *message){@throw [NSException exceptionWithName:@"RegistrationError" reason:message userInfo:nil];}
static BOOL Running(){for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications)if([app.bundleIdentifier hasPrefix:@"com.adobe.PremierePro"])return YES;return NO;}
static NSArray<NSXMLElement*> *Children(NSXMLElement *node,NSString *name){return [node elementsForName:name];}
static NSXMLElement *One(NSXMLElement *node,NSString *name){NSArray *found=Children(node,name);if(found.count!=1)Fail([@"설정 XML 구조를 확인할 수 없습니다: " stringByAppendingString:name]);return found[0];}
static NSMutableDictionary *Pairs(NSXMLElement *list){
  NSMutableDictionary *result=[NSMutableDictionary dictionary];
  for(NSXMLNode *node in list.children){
    if(node.kind!=NSXMLElementKind)continue;
    NSXMLElement *entry=(NSXMLElement*)node;
    if(![entry.name isEqual:@"prop.pair"])Fail(@"알 수 없는 설정 목록 형식입니다.");
    NSString *key=One(entry,@"key").stringValue;
    if(!key.length||result[key])Fail(@"중복되거나 빈 설정 키입니다.");
    result[key]=entry;
  }return result;
}
static NSXMLElement *Entry(NSString *key,NSXMLElement *value){NSXMLElement *entry=[NSXMLElement elementWithName:@"prop.pair"];[entry addChild:[NSXMLElement elementWithName:@"key" stringValue:key]];[entry addChild:value];return entry;}
static NSXMLElement *Group(NSXMLElement *list,NSString *key,BOOL *changed){
  NSXMLElement *entry=Pairs(list)[key];
  if(entry)return One(entry,@"prop.list");
  NSXMLElement *child=[NSXMLElement elementWithName:@"prop.list"];[list addChild:Entry(key,child)];*changed=YES;return child;
}
static void SetString(NSXMLElement *list,NSString *key,NSString *value,BOOL *changed){
  NSXMLElement *entry=Pairs(list)[key];
  if(entry){NSXMLElement *string=One(entry,@"ustring");if(![string.stringValue isEqual:value]){string.stringValue=value;*changed=YES;}}
  else{[list addChild:Entry(key,[NSXMLElement elementWithName:@"ustring" stringValue:value])];*changed=YES;}
}
static BOOL CheckPath(NSString *path,struct stat *value){
  if(lstat(path.fileSystemRepresentation,value)==0){if(S_ISLNK(value->st_mode))Fail(@"심볼릭 링크 설정 경로는 변경하지 않습니다.");return YES;}
  if(errno!=ENOENT)Fail(@"설정 경로에 접근할 수 없습니다.");return NO;
}
static NSDictionary *Register(NSString *path){
  if(!path.isAbsolutePath)Fail(@"설정 파일은 절대 경로여야 합니다.");
  // Check all existing ancestors, including a redirected ControlSurface folder.
  NSString *ancestor=path;
  while(ancestor.length>1){struct stat info;CheckPath(ancestor,&info);ancestor=ancestor.stringByDeletingLastPathComponent;}
  struct stat original={0};BOOL exists=CheckPath(path,&original);
  if(exists&&(!S_ISREG(original.st_mode)||original.st_uid!=geteuid()||original.st_size>4*1024*1024))Fail(@"설정 파일 소유권·형식·크기를 확인하세요.");
  NSData *before=exists?[NSData dataWithContentsOfFile:path]:nil;
  if(exists&&!before)Fail(@"기존 설정을 읽지 못했습니다.");
  NSXMLDocument *doc;BOOL changed=NO;
  if(before){
    NSString *raw=[[NSString alloc]initWithData:before encoding:NSUTF8StringEncoding];
    if(!raw||[raw rangeOfString:@"<!DOCTYPE" options:NSCaseInsensitiveSearch].location!=NSNotFound||[raw rangeOfString:@"<!ENTITY" options:NSCaseInsensitiveSearch].location!=NSNotFound)Fail(@"지원하지 않는 설정 XML입니다.");
    NSError *error=nil;doc=[[NSXMLDocument alloc]initWithData:before options:NSXMLNodePreserveAll|NSXMLNodeLoadExternalEntitiesNever error:&error];
    if(!doc)Fail(@"설정 XML이 손상되어 변경하지 않았습니다.");
  }else{
    NSXMLElement *root=[NSXMLElement elementWithName:@"prop.map"];[root addAttribute:[NSXMLNode attributeWithName:@"version" stringValue:@"4"]];[root addChild:[NSXMLElement elementWithName:@"prop.list"]];doc=[[NSXMLDocument alloc]initWithRootElement:root];doc.version=@"1.0";changed=YES;
  }
  NSXMLElement *root=doc.rootElement;
  if(![root.name isEqual:@"prop.map"]||![[root attributeForName:@"version"].stringValue isEqual:@"4"])Fail(@"지원하지 않는 설정 버전입니다.");
  NSXMLElement *top=One(root,@"prop.list");
  NSXMLElement *active=Group(top,@"ActivePluginIDs",&changed);NSMutableDictionary *ids=Pairs(active);BOOL found=NO;
  for(NSXMLElement *entry in ids.allValues)if([One(entry,@"ustring").stringValue isEqual:PluginID])found=YES;
  if(!found){NSUInteger i=0;while(ids[[NSString stringWithFormat:@"PluginID%lu",(unsigned long)i]])i++;SetString(active,[NSString stringWithFormat:@"PluginID%lu",(unsigned long)i],PluginID,&changed);}
  NSXMLElement *catalog=Group(top,@"PluginList",&changed);NSXMLElement *module=Group(catalog,ModulePath,&changed);
  NSXMLElement *oldID=Pairs(module)[@"ID"];
  if(oldID&&![One(oldID,@"ustring").stringValue isEqual:PluginID])Fail(@"설치 경로가 다른 컨트롤 표면에 등록되어 있습니다.");
  SetString(module,@"ID",PluginID,&changed);SetString(module,@"Name",@"Mask Tracker",&changed);
  Group(Group(top,@"PluginSettingsList",&changed),PluginID,&changed);
  if(!Pairs(top)[@"SettingsVersion"]){NSXMLElement *version=[NSXMLElement elementWithName:@"int" stringValue:@"1"];[version addAttribute:[NSXMLNode attributeWithName:@"type" stringValue:@"unsigned"]];[version addAttribute:[NSXMLNode attributeWithName:@"size" stringValue:@"32"]];[top addChild:Entry(@"SettingsVersion",version)];changed=YES;}
  if(!changed)return @{@"path":path,@"status":@"already_registered"};
  NSString *directory=path.stringByDeletingLastPathComponent;NSError *error=nil;
  if(![NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:&error])Fail(@"설정 폴더를 만들지 못했습니다.");
  NSString *backup=@"";
  if(exists){backup=[path stringByAppendingFormat:@".mask-tracker-backup-%@",NSUUID.UUID.UUIDString];if(![NSFileManager.defaultManager copyItemAtPath:path toPath:backup error:&error])Fail(@"기존 설정 백업에 실패했습니다.");}
  NSString *temporary=[directory stringByAppendingPathComponent:@".mask-tracker-register-XXXXXX"];char *temp=strdup(temporary.fileSystemRepresentation);int fd=mkstemp(temp);
  if(fd<0){free(temp);Fail(@"설정 임시 파일 생성에 실패했습니다.");}
  BOOL okay=YES;NSData *data=[doc XMLDataWithOptions:NSXMLNodePreserveAll];const uint8_t *bytes=(const uint8_t*)data.bytes;NSUInteger offset=0;
  if(fchmod(fd,exists?(original.st_mode&0777):0600)!=0)okay=NO;
  if(exists&&fchown(fd,original.st_uid,original.st_gid)!=0)okay=NO;
  while(okay&&offset<data.length){ssize_t n=write(fd,bytes+offset,data.length-offset);if(n<0&&errno==EINTR)continue;if(n<=0){okay=NO;break;}offset+=(NSUInteger)n;}
  if(fsync(fd)!=0)okay=NO;if(close(fd)!=0)okay=NO;
  if(Running())okay=NO;
  if(exists&&![[NSData dataWithContentsOfFile:path]isEqual:before])okay=NO;
  if(!exists&&[NSFileManager.defaultManager fileExistsAtPath:path])okay=NO;
  if(okay&&rename(temp,path.fileSystemRepresentation)!=0)okay=NO;
  if(!okay){unlink(temp);free(temp);Fail(@"설정 저장을 중단했습니다. Premiere 종료 여부와 기존 설정을 확인하세요.");}free(temp);
  return @{@"path":path,@"status":@"registered",@"backup":backup};
}
int main(int argc,const char **argv){@autoreleasepool{@try{
  if(geteuid()==0)Fail(@"로그인한 사용자 권한으로 실행하세요.");
  if(Running())Fail(@"Premiere를 종료한 뒤 다시 실행하세요.");
  NSMutableArray *paths=[NSMutableArray array];
  if(argc==3&&strcmp(argv[1],"--settings-file")==0)[paths addObject:[NSString stringWithUTF8String:argv[2]]];
  else if(argc==1){
    NSString *prefs=[NSHomeDirectory()stringByAppendingPathComponent:@"Library/Preferences/Adobe/Premiere Pro"];
    for(NSString *version in [NSFileManager.defaultManager contentsOfDirectoryAtPath:prefs error:nil])if([version rangeOfString:@"^[0-9]+\\.[0-9]+$" options:NSRegularExpressionSearch].location!=NSNotFound)[paths addObject:[[prefs stringByAppendingPathComponent:version]stringByAppendingPathComponent:@"ControlSurface/ControlSurfaceSettings.xml"]];
    // A newly installed Premiere may not have created its preferences yet.
    NSDirectoryEnumerator *apps=[NSFileManager.defaultManager enumeratorAtURL:[NSURL fileURLWithPath:@"/Applications"] includingPropertiesForKeys:@[NSURLIsPackageKey] options:NSDirectoryEnumerationSkipsHiddenFiles errorHandler:nil];
    for(NSURL *url in apps)if([url.pathExtension isEqual:@"app"]){[apps skipDescendants];NSBundle *app=[NSBundle bundleWithURL:url];if([app.bundleIdentifier hasPrefix:@"com.adobe.PremierePro"]){NSString *major=[app.infoDictionary[@"CFBundleShortVersionString"]componentsSeparatedByString:@"."].firstObject;if(major.length){NSString *path=[[prefs stringByAppendingPathComponent:[major stringByAppendingString:@".0"]]stringByAppendingPathComponent:@"ControlSurface/ControlSurfaceSettings.xml"];if(![paths containsObject:path])[paths addObject:path];}}}
    if(!paths.count)Fail(@"Premiere 환경설정 위치를 찾지 못했습니다. Premiere를 한 번 실행한 뒤 다시 설치하세요.");
  }else Fail(@"잘못된 실행 인수입니다.");
  NSMutableArray *results=[NSMutableArray array];for(NSString *path in paths)[results addObject:Register(path)];NSData *json=[NSJSONSerialization dataWithJSONObject:results options:0 error:nil];puts([[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding].UTF8String);return 0;
}@catch(NSException *error){fprintf(stderr,"Mask Tracker: %s\n",error.reason.UTF8String);return 1;}}}
