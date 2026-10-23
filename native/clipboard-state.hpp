#pragma once
#import <AppKit/AppKit.h>

// Only materialized bytes are backed up, in memory. No clipboard payloads are
// written to files, IPC, or logs. An unreadable item must never count as empty.
enum class ClipboardSnapshotStatus { Ready, ItemsUnavailable, DataUnavailable, Changed, TooLarge, AccessDenied };
struct ClipboardSnapshot {
  ClipboardSnapshotStatus status=ClipboardSnapshotStatus::ItemsUnavailable;
  NSArray *items=nil;
  NSInteger generation=0;
};
static bool retryableClipboardSnapshot(ClipboardSnapshotStatus status) {
  return status==ClipboardSnapshotStatus::ItemsUnavailable || status==ClipboardSnapshotStatus::DataUnavailable || status==ClipboardSnapshotStatus::Changed;
}
static ClipboardSnapshot snapshotClipboard(NSPasteboard *pb,NSUInteger maximumBytes=256u*1024u*1024u) {
  ClipboardSnapshot result;
  result.generation=pb.changeCount;
  @try {
    if(@available(macOS 15.4,*)) {
      if(pb.accessBehavior==NSPasteboardAccessBehaviorAlwaysDeny){result.status=ClipboardSnapshotStatus::AccessDenied;return result;}
    }
    NSArray<NSPasteboardItem*> *source=pb.pasteboardItems;
    if(!source){result.status=ClipboardSnapshotStatus::ItemsUnavailable;return result;}
    NSMutableArray *items=[NSMutableArray new];NSUInteger total=0;
    for(NSPasteboardItem *item in source) {
      NSMutableArray *types=[NSMutableArray new];
      NSArray *sourceTypes=item.types;
      if(!sourceTypes || !sourceTypes.count){result.status=ClipboardSnapshotStatus::DataUnavailable;return result;}
      for(NSPasteboardType type in sourceTypes) {
        NSData *data=[item dataForType:type];
        if(!data){result.status=ClipboardSnapshotStatus::DataUnavailable;return result;}
        if(data.length>maximumBytes || total>maximumBytes-data.length){result.status=ClipboardSnapshotStatus::TooLarge;return result;}
        total+=data.length;
        [types addObject:@{@"type":type,@"data":[data copy]}];
      }
      // An owner may add promised representations without changing changeCount.
      if(![item.types isEqualToArray:sourceTypes]){result.status=ClipboardSnapshotStatus::Changed;return result;}
      [items addObject:types];
    }
    if(pb.changeCount!=result.generation){result.status=ClipboardSnapshotStatus::Changed;return result;}
    result.items=[items copy];result.status=ClipboardSnapshotStatus::Ready;
  } @catch(NSException *) {result.status=ClipboardSnapshotStatus::DataUnavailable;}
  return result;
}
// Re-enumerate items on every attempt; stale NSPasteboardItems cannot recover.
// The main queue is yielded between attempts, rather than sleeping Premiere.
static void snapshotClipboardWithRetry(NSPasteboard *pb,void (^completion)(ClipboardSnapshot),NSUInteger attempt=0) {
  ClipboardSnapshot snapshot=snapshotClipboard(pb);
  if(snapshot.status!=ClipboardSnapshotStatus::AccessDenied && pb.changeCount!=snapshot.generation) {
    snapshot.status=ClipboardSnapshotStatus::Changed;snapshot.items=nil;
  }
  if(retryableClipboardSnapshot(snapshot.status) && attempt<2) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)((attempt+1)*50*NSEC_PER_MSEC)),dispatch_get_main_queue(),^{
      snapshotClipboardWithRetry(pb,completion,attempt+1);
    });
    return;
  }
  completion(snapshot);
}
static BOOL clipboardEquals(NSPasteboard *pb,NSArray *snapshot) {
  if(!snapshot)return NO;
  NSInteger generation=pb.changeCount;
  NSArray *items=pb.pasteboardItems;
  if(!items || items.count!=snapshot.count)return NO;
  for(NSUInteger i=0;i<items.count;i++) {
    NSPasteboardItem *item=items[i];NSArray *types=snapshot[i];
    if(item.types.count!=types.count)return NO;
    for(NSDictionary *entry in types) {
      if(![item.types containsObject:entry[@"type"]] || ![[item dataForType:entry[@"type"]] isEqualToData:entry[@"data"]])return NO;
    }
  }
  return pb.changeCount==generation;
}
static BOOL restoreClipboard(NSPasteboard *pb,NSArray *snapshot,NSInteger ownedCount) {
  if(!snapshot || pb.changeCount!=ownedCount)return NO;
  if(clipboardEquals(pb,snapshot))return YES;
  NSMutableArray *items=[NSMutableArray new];
  for(NSArray *types in snapshot) {
    NSPasteboardItem *item=[NSPasteboardItem new];
    for(NSDictionary *entry in types)if(![item setData:entry[@"data"] forType:entry[@"type"]])return NO;
    [items addObject:item];
  }
  // Preserve a newer copy made while constructing the restoration items too.
  if(pb.changeCount!=ownedCount)return NO;
  [pb clearContents];
  if(items.count && ![pb writeObjects:items])return NO;
  return clipboardEquals(pb,snapshot);
}
