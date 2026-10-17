# Mask Motion 0.3.2

Premiere에서 추적한 불투명도 마스크의 알파 중심 이동을 대상 클립의 변형(Transform) Position 키프레임으로 변환하는 UXP 플러그인입니다. 중첩이나 AE 실행은 필요 없습니다.

## 설치

Premiere 설정 → Plugins에서 Developer Mode를 켭니다. UXP Developer Tool에 이 폴더의 `manifest.json`을 등록하고 **Load & Watch**로 실행합니다. 기존 등록은 **Reload**한 뒤 패널 버전 **0.3.2**을 확인하세요. 빌드나 npm install은 필요 없습니다. 최소 Premiere 26.0입니다.

## 두 단계 사용법

1. 원본 클립의 불투명도에 마스크를 적용하고 Premiere에서 마스크 추적을 완료합니다. 원본 하나를 선택하고 **클립 전체 측정**을 누릅니다. 재생헤드 위치나 길이 입력은 필요 없습니다.
2. 측정이 끝나면 원본 마스크를 비활성화하고, 움직일 대상 클립의 위치를 평소처럼 맞춘 뒤 선택합니다. **선택한 대상에 적용**을 누릅니다. 새 변형 효과 추가와 키프레임 적용을 한 번에 진행합니다.

범위는 타임라인에서 선택한 원본 클립의 시작부터 끝 직전 마지막 프레임까지입니다. 대상 클립은 이 측정 구간 전체를 포함해야 하며 정방향 100% 속도여야 합니다. 원본 Position 키프레임은 필요 없습니다. 대상의 기존 효과는 기본 모드에서 수정하지 않습니다.

선택한 원본/대상 이름과 트랙, 원본 길이를 표시합니다. 첫 프레임의 알파 검사를 통과하면 진행률을 표시하고 나머지 구간을 계속 측정합니다. 화면 전체가 불투명하거나 투명한 픽셀이 1% 미만이면 측정을 중단하고 불투명도 마스크 적용을 안내합니다. 이는 렌더 결과 검증이며 마스크 연결 여부를 DOM에서 직접 판별하는 것이 아닙니다. **측정 중지**로 중단할 수 있으며, 완료되지 않은 좌표는 적용하지 않습니다.

## 고급 설정 및 저장

- 측정 가로 해상도: 기본 640px, 160–1920px. 총 400만 픽셀 이하.
- 측정 간격: 기본 매 프레임. 간격을 늘려도 마지막 유효 프레임은 포함합니다.
- 새 변형 대신 기본 Motion에 적용: 효과를 추가하지 않고 기본 Motion Position에 씁니다. 기존 Position 애니메이션이 있으면 거부합니다.
- 좌표 기준 가로·세로: 0/0은 자동. 자동 확인이 안 되면 대상 원본 또는 그래픽 캔버스 크기를 입력합니다.
- 측정 불러오기/저장, 트랙 표시 복구, 실제 적용 방식 진단, 진단 결과 저장을 제공합니다.

600프레임 제한을 제거했습니다. 한 번에 최대 10만 샘플을 처리하고, 초과 시 간격을 늘리도록 안내합니다. 범위를 잘라서 조용히 완료 처리하지 않습니다. 긴 클립은 처리 시간이 길 수 있습니다.

폴더 선택 없이 플러그인 데이터 폴더의 고유 `mask-motion-*` 폴더에 첫/마지막 TGA와 `tracking.json`을 자동 저장합니다. 중간 프레임은 읽은 뒤 삭제하고 실패 프레임은 진단용으로 남깁니다. 이전 측정은 자동 복구하지 않습니다. 고급 설정의 **최근 측정 불러오기**를 눌러 복구합니다. 원본 카드는 현재 선택한 클립의 이름·트랙·실제 길이를 갱신하고, 완료된 측정 데이터의 원본은 아래 메시지에 별도로 표시합니다. 외부 보관은 **측정 저장**을 사용합니다. 기존 버전의 부분 측정 JSON도 불러올 수 있으며 그 파일의 구간을 그대로 적용합니다. 프로젝트의 `tracking-data/last-tracking.json`과 사용자 데이터는 배포 ZIP에 포함하지 않습니다.

## 적용 및 실행 취소

정적 Position 값에 측정 시작 이후의 중심 이동량을 더합니다. 재생헤드를 측정 시작에 맞출 필요가 없습니다. 기본 모드는 새 변형 효과의 Position에만 키프레임을 생성합니다. 일괄 적용 후 예상 시간 밖의 추가 키프레임을 제거하고, 최종 시간·개수·각 값을 다시 읽어 검증합니다. 정상 시작 키프레임이 0프레임인 경우에는 유지합니다.

효과 추가, 키프레임 적용, 추가 키프레임 정리는 각각 실행 취소 이력에 남습니다. 전체 적용을 되돌리려면 발생한 정리 작업, 키프레임 적용, 효과 추가를 차례로 실행 취소합니다. 적용 오류 시 새 효과가 남을 수 있으며 패널 상세에 해당 대상이 표시됩니다. 기존의 실패/과거 효과는 자동 수정하지 않습니다.

## 좌표 및 측정 조건

알파값을 가중치로 사용한 전체 불투명 영역의 무게중심입니다. 검은 RGB를 배경으로 간주하지 않습니다. 여러 마스크가 있으면 합쳐진 중심이 됩니다. 측정 중 대상이 사라지거나 화면 끝에 닿거나 투명한 배경이 사라지면 실패 처리합니다. 형태 변화에 따른 중심 흔들림, Scale/Rotation 추적, 원근 추적, 가림 복원은 지원하지 않습니다.

Transform의 좌표 기준은 중첩 해상도 또는 공개 Metadata API의 원본 영상/이미지 정보이며, 미디어 경로가 없는 생성 그래픽은 시퀀스 크기를 사용합니다. Metadata에는 원래 ProjectItem을 전달합니다. 자동 확인이 안 되면 고급 설정에서 입력하세요. 고정 Motion Scale·Width Scale·Rotation은 역변환하지만 애니메이션된 Scale/Rotation, 비정방형 픽셀 변환 및 모든 그래픽 구성의 정확도는 보장하지 않습니다. 그래픽 내부 개별 레이어가 아니라 클립 전체를 움직입니다.

다른 비디오 트랙은 측정 중 숨기고 끝나면 복구합니다. 측정 중 트랙·시퀀스·원본 클립·마스크를 편집하지 마세요. 취소/실패에도 복구하며, 복구 실패 시 고급 설정에서 재시도합니다. 캡션 트랙과 측정 구간의 전환 효과는 거부합니다. 강제 종료 시에는 트랙 표시 상태를 확인하세요.

프레임은 공개 Exporter API로 렌더합니다. 자체 TGA 디코더는 raw/RLE 32비트 true-color와 네 번째 채널의 알파를 읽습니다. Premiere 26.5.2가 알파 비트 수를 0으로 기록한 파일은 직접 생성한 호스트 프레임에 한해 허용합니다. 저장 직후 비어 있거나 덜 기록된 파일은 최대 5초 재시도합니다.

## 진단

**실제 적용 방식으로 진단**은 새 임시 변형 효과에서 정상 적용과 동일한 전체 키프레임 일괄 트랜잭션 및 추가 키프레임 정리를 실행합니다. 완료/실패 모두 임시 효과 제거를 시도하며 결과를 검증합니다. 따라서 진단 키프레임은 남지 않습니다. `application.removedUnexpected`에 제거 전 시간과 값이 기록됩니다. **진단 결과 저장**은 이 보고서를 `mask-motion-diagnostic.json`으로 저장합니다. **측정 저장**과는 별도 버튼입니다.

## 검증

사용자가 기존 측정과 추가 키프레임 정리 후 적용 완료를 확인했습니다. 0.3.2는 자동 테스트 40개와 문법 검사로 확인했습니다. 전체 클립 범위/끝 프레임, 600프레임을 넘는 데이터, 재생헤드와 무관한 측정·적용, 두 단계 UI, 불투명 프레임 거부, 취소/복구, 실제 적용 경로 및 정확한 키프레임 검증을 포함합니다. 새로운 패널의 실제 UXP 호스트 표시와 긴 클립 전체 실행은 사용자 확인이 필요합니다.

```sh
npm test
npm run check
```

## 공개 API 근거와 후속 경계

- [Adobe VideoFilterFactory](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/videofilterfactory)와 [VideoComponentChain](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/videocomponentchain): 효과 생성 및 추가 action.
- [Adobe ComponentParam](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/componentparam), [PointF](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/pointf), [공식 키프레임 샘플](https://github.com/AdobeDocs/uxp-premiere-pro-samples/blob/main/sample-panels/premiere-api/src/keyframe.ts): 공개 값 생성과 트랜잭션 기반 키프레임 쓰기.
- [Adobe Metadata](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/metadata): 프로젝트 항목의 공개 메타데이터 읽기.
- [Adobe Exporter](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/exporter), [공식 프레임 내보내기 샘플](https://github.com/AdobeDocs/uxp-premiere-pro-samples/blob/main/sample-panels/premiere-api/src/export.ts), [VideoTrack](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/videotrack): 프레임 저장과 트랙 표시 제어.
- [Kamil Pekala의 Motion Tracker Premiere 26+](https://kamilpekala.com/): 추적된 Opacity 마스크를 측정하고 대상 Motion에 붙이는 기존 제품의 공개 흐름. 이 구현은 그 제품의 비공개 알고리즘을 확인하거나 복제한 것이 아닙니다.

Object Mask 내부 좌표가 DOM에서 노출되지 않는다는 기존 Probe 결과와 렌더 측정을 이용한 변환은 별개의 접근입니다. 다른 호스트가 프레임 알파를 보존하지 않는다면 같은 Probe를 반복하지 않고 SDK `SequenceRenderSuite`의 BGRA 렌더(`inCompositeOnBlack = 0`)와 PPix 알파 읽기로 넘어갑니다. Hybrid 모듈을 만들었다고 이 suite를 자동 사용할 수 있는 것은 아닙니다. Adobe SDK는 별도 레퍼런스이며 이 저장소나 배포 파일에 포함하지 않습니다.

