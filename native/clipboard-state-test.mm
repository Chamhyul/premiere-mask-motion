// Uses isolated named pasteboards, never the user's general clipboard.
#include "clipboard-state.hpp"
#include <cassert>

@interface MTClipboardProbe : NSObject
@property NSPasteboard *board;
@property NSUInteger reads;
@property BOOL denied;
@property(copy) NSArray* (^readItems)(NSUInteger);
@end
@implementation MTClipboardProbe
- (NSInteger)changeCount {return self.board.changeCount;}
- (NSArray*)pasteboardItems {self.reads++;return self.readItems(self.reads);}
- (NSPasteboardAccessBehavior)accessBehavior {return self.denied?NSPasteboardAccessBehaviorAlwaysDeny:NSPasteboardAccessBehaviorAlwaysAllow;}
@end
@interface MTUnavailableItem : NSPasteboardItem
@property NSUInteger reads;
@property BOOL recover;
@end
@implementation MTUnavailableItem
- (NSArray*)types {return @[@"local.masktracker.promised"];}
- (NSData*)dataForType:(NSPasteboardType)type {
  self.reads++;
  if(self.recover && self.reads>1)return [@"promised bytes" dataUsingEncoding:NSUTF8StringEncoding];
  return nil;
}
@end
static ClipboardSnapshot backup(NSPasteboard *pb) {
  __block BOOL done=NO;__block ClipboardSnapshot result;
  snapshotClipboardWithRetry(pb,^(ClipboardSnapshot snapshot){result=snapshot;done=YES;});
  NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:3];
  while(!done && deadline.timeIntervalSinceNow>0)
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  assert(done);return result;
}
static void replace(NSPasteboard *pb,NSString *text) {
  [pb clearContents];assert([pb setString:text forType:NSPasteboardTypeString]);
}
static void roundtrip(NSPasteboard *pb,ClipboardSnapshot snapshot) {
  assert(snapshot.status==ClipboardSnapshotStatus::Ready && snapshot.items!=nil);
  replace(pb,@"temporary Premiere copy");
  assert(restoreClipboard(pb,snapshot.items,pb.changeCount));
  assert(clipboardEquals(pb,snapshot.items));
}
int main(){@autoreleasepool{
  NSPasteboard *pb=NSPasteboard.pasteboardWithUniqueName;
  NSPasteboardItem *one=[NSPasteboardItem new],*two=[NSPasteboardItem new];
  [one setString:@"한글 clipboard" forType:NSPasteboardTypeString];
  [one setData:[NSData dataWithBytes:"\0\1\xff\0" length:4] forType:@"local.masktracker.binary"];
  [two setString:@"file:///tmp/example.png" forType:NSPasteboardTypeFileURL];
  assert(([pb writeObjects:@[one,two]]));
  ClipboardSnapshot original=backup(pb);assert(original.items.count==2);
  roundtrip(pb,original);puts("PASS: text, binary, file URL and multiple item restoration");

  NSInteger old=pb.changeCount;replace(pb,@"new user copy");
  assert(!restoreClipboard(pb,original.items,old));
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"new user copy"]);
  puts("PASS: intervening user copy is preserved");

  [pb clearContents];ClipboardSnapshot empty=backup(pb);
  assert(empty.status==ClipboardSnapshotStatus::Ready && empty.items.count==0);
  roundtrip(pb,empty);puts("PASS: genuinely empty clipboard restoration");
  // A real zero-byte representation is data, not a failed read.
  NSPasteboardItem *zero=[NSPasteboardItem new];[zero setData:NSData.data forType:@"local.masktracker.empty"];
  assert([pb writeObjects:@[zero]]);roundtrip(pb,backup(pb));
  puts("PASS: zero-byte representations retained");

  replace(pb,@"keep original");
  MTClipboardProbe *probe=[MTClipboardProbe new];probe.board=pb;
  probe.readItems=^NSArray*(NSUInteger){return nil;};
  ClipboardSnapshot failed=backup((NSPasteboard*)probe);
  assert(failed.status==ClipboardSnapshotStatus::ItemsUnavailable && failed.items==nil && probe.reads==3);
  assert(!clipboardEquals((NSPasteboard*)probe,@[]));
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"keep original"]);
  puts("PASS: nil item query is not empty; bounded retries leave original untouched");

  probe.reads=0;probe.readItems=^NSArray*(NSUInteger n){return n==1?nil:pb.pasteboardItems;};
  ClipboardSnapshot recovered=backup((NSPasteboard*)probe);
  assert(probe.reads==2);roundtrip(pb,recovered);
  puts("PASS: temporary item query failure recovers and restores original");

  MTUnavailableItem *promised=[MTUnavailableItem new];promised.recover=YES;
  probe.reads=0;probe.readItems=^NSArray*(NSUInteger){return @[promised];};
  recovered=backup((NSPasteboard*)probe);
  assert(probe.reads==2 && promised.reads==2);roundtrip(pb,recovered);
  assert([[pb dataForType:@"local.masktracker.promised"] isEqualToData:[@"promised bytes" dataUsingEncoding:NSUTF8StringEncoding]]);
  puts("PASS: temporary representation failure retries without dropping formats");

  replace(pb,@"keep on permanent failure");promised=[MTUnavailableItem new];
  probe.reads=0;probe.readItems=^NSArray*(NSUInteger){return @[promised];};
  failed=backup((NSPasteboard*)probe);
  assert(failed.status==ClipboardSnapshotStatus::DataUnavailable && failed.items==nil && probe.reads==3);
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"keep on permanent failure"]);
  puts("PASS: permanent representation failure preserves clipboard");

  // Replacement during enumeration invalidates the old generation. The next
  // attempt must enumerate the new owner rather than reuse stale item objects.
  replace(pb,@"old before enumeration");
  probe.reads=0;probe.readItems=^NSArray*(NSUInteger n){
    if(n==1)replace(pb,@"latest during enumeration");
    return pb.pasteboardItems;
  };
  recovered=backup((NSPasteboard*)probe);assert(probe.reads==2);
  assert(recovered.generation==pb.changeCount);roundtrip(pb,recovered);
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"latest during enumeration"]);
  puts("PASS: changed generation rebacks up and restores latest clipboard");

  // A second application can also copy while we are waiting to retry.
  replace(pb,@"before retry");probe.reads=0;
  probe.readItems=^NSArray*(NSUInteger n){return n==1?nil:pb.pasteboardItems;};
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_MSEC),dispatch_get_main_queue(),^{replace(pb,@"latest between attempts");});
  recovered=backup((NSPasteboard*)probe);assert(probe.reads==2);roundtrip(pb,recovered);
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"latest between attempts"]);
  puts("PASS: copies between attempts become the new restoration baseline");

  ClipboardSnapshot small=snapshotClipboard(pb,1);
  assert(small.status==ClipboardSnapshotStatus::TooLarge && small.items==nil);
  assert(!retryableClipboardSnapshot(small.status));
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"latest between attempts"]);
  puts("PASS: size limit remains fail-safe and does not clear clipboard");
  probe.denied=YES;probe.reads=0;
  failed=backup((NSPasteboard*)probe);
  assert(failed.status==ClipboardSnapshotStatus::AccessDenied && probe.reads==0);
  assert(!retryableClipboardSnapshot(failed.status));probe.denied=NO;
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"latest between attempts"]);
  puts("PASS: denied access is distinct and leaves clipboard untouched");

  probe.reads=0;probe.readItems=^NSArray*(NSUInteger n){
    replace(pb,[NSString stringWithFormat:@"continuing user copy %lu",(unsigned long)n]);
    return pb.pasteboardItems;
  };
  failed=backup((NSPasteboard*)probe);
  assert(failed.status==ClipboardSnapshotStatus::Changed && failed.items==nil && probe.reads==3);
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"continuing user copy 3"]);
  puts("PASS: continuous changes stop after three attempts and retain latest copy");

  replace(pb,@"before restoration race");ClipboardSnapshot saved=backup(pb);
  replace(pb,@"temporary owned copy");old=pb.changeCount;
  probe.reads=0;probe.readItems=^NSArray*(NSUInteger){
    replace(pb,@"user copy during restoration check");return pb.pasteboardItems;
  };
  assert(!restoreClipboard((NSPasteboard*)probe,saved.items,old));
  assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"user copy during restoration check"]);
  puts("PASS: new copy during restoration verification is not overwritten");
  [pb releaseGlobally];puts("14 clipboard preservation checks passed");
}}
