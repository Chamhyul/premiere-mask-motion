// Uses an isolated pasteboard, never the user's general clipboard.
#include "MaskTrackerClipboard.mm"
#include <cassert>
int main(){@autoreleasepool{
 NSPasteboard *pb=NSPasteboard.pasteboardWithUniqueName;
 NSPasteboardItem *one=[NSPasteboardItem new],*two=[NSPasteboardItem new];
 [one setString:@"한글 clipboard" forType:NSPasteboardTypeString];
 [one setData:[NSData dataWithBytes:"\0\1\xff\0" length:4] forType:@"local.masktracker.binary"];
 [two setString:@"file:///tmp/example.png" forType:NSPasteboardTypeFileURL];
 assert(([pb writeObjects:@[one,two]]));
 NSArray *snapshot=snapshotClipboard(pb);assert(snapshot.count==2);
 [pb clearContents];[pb setString:@"temporary copy" forType:NSPasteboardTypeString];
 assert(restoreClipboard(pb,snapshot,pb.changeCount));assert(clipboardEquals(pb,snapshot));
 NSInteger old=pb.changeCount;
 [pb clearContents];[pb setString:@"new user copy" forType:NSPasteboardTypeString];
 assert(!restoreClipboard(pb,snapshot,old));assert([[pb stringForType:NSPasteboardTypeString] isEqual:@"new user copy"]);
 [pb clearContents];NSArray *empty=snapshotClipboard(pb);assert(empty.count==0);
 [pb setString:@"temporary" forType:NSPasteboardTypeString];
 assert(restoreClipboard(pb,empty,pb.changeCount));assert(clipboardEquals(pb,empty));
 [pb releaseGlobally];puts("clipboard: text, custom binary, multiple items, intervening copy, empty restoration passed");
}}
