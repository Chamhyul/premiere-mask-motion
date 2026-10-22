# Mask Tracker 소스

Premiere UXP 패널입니다. 사용 가이드는 저장소 최상위 `README.md`, Windows 빌드는 `native/windows/README.md`를 참고하세요.

```sh
npm run check
npm test
npm run build
```

빌드는 현재 OS에 맞는 CCX·네이티브 모듈·통합 설치 파일을 만듭니다. 설치하거나 게시하지 않습니다. Premiere C++ SDK는 별도로 준비하고 `PREMIERE_CPP_SDK`로 경로를 지정합니다. Windows는 VS 2022 x64 C++ 도구·Windows SDK·Python·Node.js·Inno Setup 6.3 이상이 필요합니다.

저장소에서 빌드하면 최상위 `dist/`에, 기존 로컬 개발 폴더 구조에서는 `distribution/dist/`에 생성됩니다.

개발 실행은 네이티브 모듈을 연결한 뒤 UXP Developer Tools에 `manifest.json`을 등록합니다. 플러그인 ID와 패널 ID는 기존 설치와의 호환성을 위해 유지합니다. 실제 설치·호스트 검증과 자동 테스트 결과는 구분합니다.
