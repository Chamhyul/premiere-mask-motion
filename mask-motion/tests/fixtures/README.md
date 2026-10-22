These small fixtures were generated in Premiere 26.5.2 from the project's own
black-background moving-shapes test video. They contain no user footage.

- `zero-time-mask-storage.bin`: 30 fps metadata whose frame duration and media
  start fields are omitted. The mask and file GUIDs were replaced with fixed test
  GUIDs without changing the FlatBuffer layout.
- `zero-time-circle.prmf`: the white circle's seed mask at media time zero. Its
  timestamp field is omitted, while the compressed raster remains intact.
