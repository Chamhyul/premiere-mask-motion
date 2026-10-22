#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
#include <adobesdk/AdobesdkStringSuite.h>
#include <adobesdk/controlsurface/plugin/ControlSurfacePluginSuite.h>
#include <adobesdk/controlsurface/plugin/ControlSurfaceCommandSuite.h>
#include <adobesdk/controlsurface/host/ControlSurfaceHostSuite.h>
#include <adobesdk/controlsurface/host/ControlSurfaceHostCommandSuite.h>

static NSString *directory=@"/private/tmp/com.local.premiere.maskmotion";
static NSString *session;
static SPBasicSuite *basic;
static SPSuitesSuite *suites;
static SPSuiteListRef suiteList;
static ADOBESDK_StringSuite1 *strings;
static ADOBESDK_ControlSurfaceHostSuite1 *host;
static ADOBESDK_ControlSurfaceHostCommandSuite1 *commands;
static ADOBESDK_ControlSurfaceHostCommandRef commandRef;
static ADOBESDK_String copyID={},copyContext={};
static bool copyAvailable=false,inFlight=false;
static dispatch_source_t timer;
static int token;
static NSTimeInterval lastReady;

static void writeJSON(NSString *name,id value) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  [data writeToFile:[directory stringByAppendingPathComponent:name] options:NSDataWritingAtomic error:nil];
}
static NSString *stringValue(const ADOBESDK_String &s) {
  uint32_t n=0;strings->CopyToUTF8String(&s,nullptr,&n);
  if(!n||n>1048576)return @"";
  std::vector<ADOBESDK_UTF8Char> bytes(n);
  if(strings->CopyToUTF8String(&s,bytes.data(),&n))return @"";
  return [NSString stringWithUTF8String:(char*)bytes.data()]?:@"";
}
static SPErr outString(const char *value,ADOBESDK_String *out) {return strings->AllocateFromUTF8((const ADOBESDK_UTF8Char*)value,out);}
static BOOL prepareDirectory() {
  const char *path=directory.fileSystemRepresentation;
  if(mkdir(path,0700)!=0 && errno!=EEXIST)return NO;
  struct stat st;
  return lstat(path,&st)==0 && S_ISDIR(st.st_mode) && st.st_uid==getuid() && !(st.st_mode&0077);
}
static void ready() {
  writeJSON(@"ready.json",@{@"protocol":@1,@"session":session,@"pid":@(getpid()),@"copyAvailable":@(copyAvailable),@"updatedAt":@((long long)(NSDate.date.timeIntervalSince1970*1000))});
}

// Materialize every item and type before copying. Never put the user's previous
// clipboard bytes in IPC files, logs, or the returned XML.
static NSArray *snapshotClipboard(NSPasteboard *pb) {
  NSMutableArray *items=[NSMutableArray new];NSUInteger total=0;
  for(NSPasteboardItem *item in pb.pasteboardItems) {
    NSMutableArray *types=[NSMutableArray new];
    for(NSPasteboardType type in item.types) {
      NSData *data=[item dataForType:type];
      if(!data || data.length>256*1024*1024 || total>256*1024*1024-data.length)return nil;
      total+=data.length;
      [types addObject:@{@"type":type,@"data":[data copy]}];
    }
    [items addObject:types];
  }
  return items;
}
static BOOL clipboardEquals(NSPasteboard *pb,NSArray *snapshot) {
  NSArray *items=pb.pasteboardItems?:@[];
  if(items.count!=snapshot.count)return NO;
  for(NSUInteger i=0;i<items.count;i++) {
    NSPasteboardItem *item=items[i];NSArray *types=snapshot[i];
    if(item.types.count!=types.count)return NO;
    for(NSDictionary *entry in types) {
      if(![item.types containsObject:entry[@"type"]] || ![[item dataForType:entry[@"type"]] isEqualToData:entry[@"data"]])return NO;
    }
  }
  return YES;
}
static BOOL restoreClipboard(NSPasteboard *pb,NSArray *snapshot,NSInteger ownedCount) {
  // Another application copied something during our transaction: preserve that
  // newer clipboard instead of overwriting it with the earlier snapshot.
  if(pb.changeCount!=ownedCount)return NO;
  if(clipboardEquals(pb,snapshot))return YES;
  NSMutableArray *items=[NSMutableArray new];
  for(NSArray *types in snapshot) {
    NSPasteboardItem *item=[NSPasteboardItem new];
    for(NSDictionary *entry in types)if(![item setData:entry[@"data"] forType:entry[@"type"]])return NO;
    [items addObject:item];
  }
  [pb clearContents];
  if(items.count && ![pb writeObjects:items])return NO;
  return clipboardEquals(pb,snapshot);
}
static void copySelection(NSDictionary *request) {
  inFlight=true;
  NSPasteboard *pb=NSPasteboard.generalPasteboard;
  NSInteger before=pb.changeCount;
  NSArray *snapshot=snapshotClipboard(pb);
  NSString *resultName=[NSString stringWithFormat:@"result-%@.json",request[@"id"]];
  if(!snapshot || pb.changeCount!=before) {
    writeJSON(resultName,@{@"id":request[@"id"],@"session":session,@"ok":@NO,@"clipboardRestored":@YES,@"clipboardVerified":@YES,@"message":@"클립보드를 보존할 수 없어 마스크 읽기를 중단했습니다. 클립을 다시 선택하세요."});
    inFlight=false;return;
  }
  SPErr error=kSPUnimplementedError;
  @try {error=commands->ExecuteCommand(commandRef,&copyContext,&copyID);}
  @catch(NSException *) {error=kSPUnimplementedError;}
  const NSInteger commandCount=pb.changeCount;
  const NSTimeInterval deadline=NSDate.date.timeIntervalSince1970+1.0;
  __block void (^finish)(void);
  finish=^{ @autoreleasepool {
    if(!error && pb.changeCount==before && NSDate.date.timeIntervalSince1970<deadline) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_MSEC),dispatch_get_main_queue(),finish);return;
    }
    NSInteger copiedCount=pb.changeCount;
    BOOL adobeCopy=NO;
    for(NSPasteboardType type in pb.types)if([[UTType typeWithIdentifier:type].preferredMIMEType isEqual:@"com.adobe.dvaui.ppro/mz/cookie"])adobeCopy=YES;
    // A synchronous command gives us its exact pasteboard generation. If the
    // host publishes asynchronously, never treat a later non-Adobe copy as ours.
    NSInteger ownedCount=commandCount!=before?commandCount:(adobeCopy?copiedCount:before);
    NSString *xml=nil,*format=@"com.adobe.dvaui.pproae/exchange/trackitem";
    BOOL restored=NO,verified=NO;
    @try {
      if(!error && copiedCount!=before && ownedCount==copiedCount) {
        for(NSPasteboardType type in pb.types) {
          if(![[UTType typeWithIdentifier:type].preferredMIMEType isEqual:format])continue;
          NSData *data=[pb dataForType:type];
          if(data.length<=32*1024*1024)xml=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
          break;
        }
      }
    } @catch(NSException *) {xml=nil;}
    @finally {
      // Always restore on success, wrong focus, invalid XML, and command error.
      @try {restored=restoreClipboard(pb,snapshot,ownedCount);verified=restored&&clipboardEquals(pb,snapshot);}
      @catch(NSException *) {restored=NO;verified=NO;}
    }
    BOOL ok=!error&&xml.length&&restored&&verified;
    NSString *message=(!restored||!verified)?@"클립보드가 읽는 동안 변경되었습니다. 클립을 다시 선택하세요.":@"타임라인에서 비디오 클립을 다시 선택하세요.";
    writeJSON(resultName,@{@"id":request[@"id"],@"session":session,@"ok":@(ok),@"clipboardRestored":@(restored),@"clipboardVerified":@(verified),@"originalItemCount":@(snapshot.count),@"copyChangedClipboard":@(copiedCount!=before),@"format":format,@"xml":ok?xml:@"",@"message":ok?@"":message});
    inFlight=false;finish=nil;
  }};
  finish();
}
static void poll() { @autoreleasepool {
  NSTimeInterval now=NSDate.date.timeIntervalSince1970;
  if(now-lastReady>1){ready();lastReady=now;}
  if(inFlight||!copyAvailable)return;
  for(NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:directory error:nil]) {
    if(![name hasPrefix:@"request-"]||![name hasSuffix:@".json"])continue;
    NSString *path=[directory stringByAppendingPathComponent:name];
    struct stat st;if(lstat(path.fileSystemRepresentation,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||st.st_size>65536)continue;
    id parsed=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path]?:NSData.data options:0 error:nil];
    if(![parsed isKindOfClass:NSDictionary.class])continue;
    NSDictionary *r=parsed;
    NSString *rid=r[@"id"];
    if(![r isKindOfClass:NSDictionary.class]||![rid isKindOfClass:NSString.class]||rid.length>80||
       [rid rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789-"].invertedSet].location!=NSNotFound||
       ![name isEqual:[NSString stringWithFormat:@"request-%@.json",rid]]||![r[@"session"] isEqual:session]||
       ![r[@"operation"] isEqual:@"copyMask"]||[r[@"protocol"] integerValue]!=1)continue;
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
    if([r[@"deadline"] doubleValue]<now*1000)continue;
    copySelection(r);break;
  }
}}
static void findCopy() {
  uint32_t count=0;if(commands->GetCommandCount(commandRef,&count))return;
  for(uint32_t i=0;i<count;i++) {
    ADOBESDK_String ctx={},ctxName={},id={},name={};
    if(commands->GetCommand(commandRef,i,&ctx,&ctxName,&id,&name))continue;
    BOOL match=[stringValue(id) isEqual:@"cmd.edit.copy"]&&[stringValue(ctx) isEqual:@"global"];
    strings->DisposeString(&ctxName);strings->DisposeString(&name);
    if(match){copyContext=ctx;copyID=id;copyAvailable=true;break;}
    strings->DisposeString(&ctx);strings->DisposeString(&id);
  }
}
static SPErr connect(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_ControlSurfaceHostRef ref,ADOBESDK_ControlSurfaceRef *out) {
  SPErr e=host->GetCommandRef(ref,&commandRef);if(e)return e;
  if(!prepareDirectory())return kSPBadParameterError;
  *out=(ADOBESDK_ControlSurfaceRef)&token;session=NSUUID.UUID.UUIDString;
  findCopy();ready();
  timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
  dispatch_source_set_timer(timer,DISPATCH_TIME_NOW,80*NSEC_PER_MSEC,10*NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer,^{poll();});dispatch_resume(timer);
  return kSPNoError;
}
static SPErr disconnect(ADOBESDK_ControlSurfacePluginRef) {
  if(timer){dispatch_source_cancel(timer);timer=nil;}
  copyAvailable=false;commandRef=nullptr;return kSPNoError;
}
static SPErr pluginID(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_String *s){return outString("com.local.premiere.masktracker.clipboard",s);}
static SPErr pluginName(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_String *s){return outString("Mask Tracker",s);}
static SPErr getSettings(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_String *s){return outString("",s);}
static SPErr setSettings(ADOBESDK_ControlSurfacePluginRef,const ADOBESDK_String*){return kSPNoError;}
static SPErr hasDialog(ADOBESDK_ControlSurfacePluginRef,ADOBESDK_Boolean *b){*b=0;return kSPNoError;}
static SPErr runDialog(ADOBESDK_ControlSurfacePluginRef,void*,ADOBESDK_Boolean *b){*b=0;return kSPNoError;}
static SPErr noop(ADOBESDK_ControlSurfacePluginRef){return kSPNoError;}
static ADOBESDK_ControlSurfacePluginSuite1 pluginSuite={connect,disconnect,pluginID,pluginName,getSettings,setSettings,hasDialog,runDialog,noop,noop};
static SPErr config(ADOBESDK_ControlSurfaceRef,ADOBESDK_String *s){return outString("com.local.premiere.masktracker.clipboard",s);}
static SPErr flags(ADOBESDK_ControlSurfaceRef,uint32_t *f){*f=1;return kSPNoError;}
template<class T> static SPErr noRef(ADOBESDK_ControlSurfaceRef,T *out){*out=nullptr;return kSPNoError;}
static SPErr commandRefOut(ADOBESDK_ControlSurfaceRef,ADOBESDK_ControlSurfaceCommandRef *out){*out=(ADOBESDK_ControlSurfaceCommandRef)&token;return kSPNoError;}
static SPErr buttonCount(ADOBESDK_ControlSurfaceCommandRef,uint32_t *n){*n=0;return kSPNoError;}
static ADOBESDK_ControlSurfaceCommandSuite1 buttonSuite={buttonCount,nullptr,nullptr,nullptr,nullptr};
static SPErr update(ADOBESDK_ControlSurfaceRef){return kSPNoError;}
static ADOBESDK_ControlSurfaceSuite2 surfaceSuite={config,flags,noRef<ADOBESDK_ControlSurfaceTransportRef>,noRef<ADOBESDK_ControlSurfaceMixerRef>,noRef<ADOBESDK_ControlSurfaceMarkerRef>,commandRefOut,update,noRef<ADOBESDK_ControlSurfaceLumetriRef>};
static SPErr startup() {
  SPErr e=basic->AcquireSuite(kADOBESDK_StringSuite,1,(const void**)&strings);if(e)return e;
  e=basic->AcquireSuite(kADOBESDK_ControlSurfaceHostSuite,1,(const void**)&host);if(e)return e;
  e=basic->AcquireSuite(kADOBESDK_ControlSurfaceHostCommandSuite,1,(const void**)&commands);if(e)return e;
  e=basic->AcquireSuite(kSPSuitesSuite,kSPSuitesSuiteVersion,(const void**)&suites);if(e)return e;
  e=suites->AllocateSuiteList(kSPRuntimeStringPool,kSPRuntimePluginList,&suiteList);if(e)return e;
  SPSuiteRef r;
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfacePluginSuite,1,1,&pluginSuite,&r);
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfaceSuite,1,1,&surfaceSuite,&r);
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfaceSuite,2,2,&surfaceSuite,&r);
  suites->AddSuite(suiteList,nullptr,kADOBESDK_ControlSurfaceCommandSuite,1,1,&buttonSuite,&r);
  return kSPNoError;
}
static SPErr shutdown(){disconnect(nullptr);return kSPNoError;}
static SPErr create(ADOBESDK_ControlSurfacePluginRef *out){*out=(ADOBESDK_ControlSurfacePluginRef)&token;return kSPNoError;}
static SPErr destroy(ADOBESDK_ControlSurfacePluginRef){return kSPNoError;}
static SPErr getSuiteList(SPSuiteListRef *out){*out=suiteList;return kSPNoError;}
extern "C" __attribute__((visibility("default"))) SPErr EntryPoint(SPBasicSuite *b,uint32_t,uint32_t,ADOBESDK_ControlSurfaceHostID,ADOBESDK_ControlSurfacePluginFuncs *out){basic=b;*out={startup,shutdown,create,destroy,getSuiteList};return b?kSPNoError:kSPBadParameterError;}
