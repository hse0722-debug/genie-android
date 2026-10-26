# 지니 다운 도우미 — 구글 시트 고정 시드 버전

## 변경 내용

- 도우미의 원격 인증 비밀번호 입력과 1시간 인증 확인을 제거했습니다.
- 시드 직접 입력칸과 SID 적용 버튼을 제거했습니다.
- 아래 시트의 gid=0에서 C3, C4, D3, D4를 읽습니다.
  https://docs.google.com/spreadsheets/d/1KS0avSMsGkba5zeDb2IZ_v2p1bJGW7uXm5hcDV_2q24/edit?gid=0
- 화면에는 두 줄로 `C3 값: C4 값`, `D3 값: D4 값`을 표시합니다.
- 대기 중 화면을 처음 열 때와 시작 버튼을 누를 때 최신 시드를 읽습니다. 실행 중에는 해당 실행의 시드를 유지합니다.
- 시트에 접근할 수 없거나 이름/숫자 시드가 비어 있으면 시작하지 않고 오류를 표시합니다. 저장된 이전 시드만으로 새 작업을 시작하지 않습니다.
- 시드가 바뀌면 현재 계정의 앨범/곡 단계 위치를 처음으로 설정합니다.
- 지니 계정의 로그인 비밀번호와 기존 로그인·좋아요·결제·다운로드 로직은 유지했습니다.

수정 파일은 content.js, background.js, manifest.json입니다. Android 대응을 위해 사용자 허용 범위에서 작은 화면의 패널 숨김 조건을 제거하고 패널 최대 폭을 화면에 맞췄습니다. 시트 조회를 백그라운드에서 처리하기 위해 docs.google.com 및 CSV 다운로드 리디렉션 대상 googleusercontent.com 접근 권한을 추가했습니다. alert_blocker.js, popup.js, popup.html, icon.png는 원본과 바이트 단위로 동일합니다. 원본 폴더는 수정하지 않았습니다.

## 시트 준비

1. 아이폰 최신 버전과 동일한 **웹에 게시된 CSV 주소**를 사용합니다. 현재 해당 주소는 로그인 없이 HTTP 200으로 조회되므로 원본 시트의 일반 액세스 공유 권한을 변경할 필요가 없습니다. 게시를 중단하면 조회할 수 없습니다.
2. C3에 앨범명, C4에 숫자로 된 앨범 시드를 넣습니다.
3. D3에 곡명, D4에 숫자로 된 곡 시드를 넣습니다.

예: C3가 앨범명이고 C4가 88007852라면 `앨범명: 88007852`로 표시됩니다. 표시되는 실제 이름과 번호는 시트에서 가져옵니다.

## PC 설치 및 여러 사람 사용

1. ZIP을 풀거나 GitHub 저장소에서 Code → Download ZIP으로 내려받아 압축을 풉니다.
2. PC Chrome에서 chrome://extensions 를 엽니다.
3. 개발자 모드를 켜고 '압축해제된 확장 프로그램을 로드합니다'를 누릅니다.
4. manifest.json이 들어 있는 폴더를 선택합니다.
5. 지니 웹사이트를 열고 도우미에서 각자의 계정 파일을 불러온 뒤 시작합니다.

각 사용자가 자신의 브라우저에 설치하면 같은 시트의 시드를 사용하면서 각자의 계정 목록과 진행 상태를 로컬에 저장합니다. 여러 사용자 사이에서 계정 배정이나 중복 실행을 조정하는 서버 기능은 없습니다. 같은 지니 계정을 여러 기기에서 동시에 사용할 때의 세션 동작은 지니 서비스에 따릅니다.

기존 확장 프로그램을 갱신할 때는 파일을 교체한 다음 확장 관리 화면에서 새로고침하고, 지니 탭도 새로고침합니다.

## GitHub 업로드

이 폴더의 배포 파일과 README.md, .gitignore를 저장소에 올립니다. GitHub 웹에서 저장소를 연 뒤 Add file → Upload files로 업로드할 수 있습니다. manifest.json이 저장소 최상위에 오도록 올리면 설치 폴더를 찾기 쉽습니다.

계정 목록, 비밀번호가 들어 있는 TXT 파일과 개인 로그는 배포본에 포함하지 않았습니다. .gitignore는 TXT/로그 파일의 실수로 인한 git 추가를 방지합니다. 웹 업로드는 .gitignore로 차단되지 않으므로 배포 폴더의 파일만 선택합니다.

배포 저장소: https://github.com/hse0722-debug/genie-android GitHub Pages로 공개하더라도 확장 프로그램 기능이 일반 웹사이트 기능으로 바뀌지는 않습니다.

## Android 폰·태블릿 설치 (실험적)

Android Chrome에서는 PC 확장 프로그램을 실행할 수 없습니다. 이 배포본은 확장 프로그램을 별도로 설치할 수 있는 **Edge Canary for Android**를 사용하는 방식입니다. 브라우저 버전에 따라 개발자 설치 메뉴와 확장 API 지원이 달라질 수 있으며, 이 도우미의 Android 실기기 동작은 아직 검증하지 않았습니다.

1. Google Play의 Microsoft 공식 Edge Canary를 설치합니다.
2. 아래 다운로드 링크에서 genie-android.bin을 저장합니다.
3. Android 파일 관리자에서 이름을 **genie-android.crx**로 바꿉니다. 이 BIN은 서명된 CRX3 파일과 동일한 바이트입니다. 일반 ZIP의 이름을 바꾸는 방식이 아닙니다.
4. Edge Canary 설정 → Microsoft Edge 정보에서 빌드 번호를 5회 탭하여 개발자 옵션을 엽니다. 버전에 따라 메뉴 이름이나 탭 횟수가 다를 수 있습니다.
5. 개발자 옵션의 **Extension install by crx**에서 저장한 CRX 파일을 선택합니다. 해당 메뉴가 없으면 현재 버전에서는 이 설치 경로를 사용할 수 없습니다.
6. Edge Canary에서 https://www.genie.co.kr/ 를 열고 **데스크톱 사이트**를 켭니다. 도우미가 기존 PC 지니 화면의 요소를 사용하기 때문입니다.
7. 도우미에서 본인의 계정 TXT를 불러오고 시작합니다. 로그인·좋아요·결제·다운로드 API와 팝업 동작은 Android 브라우저에서 별도 확인이 필요합니다. 먼저 한 계정으로 확인해주세요.

패널은 작은 화면에서도 표시되며 화면 너비에 맞춰 줄어듭니다. 원본의 마우스 드래그 기능은 유지했고 터치 드래그 기능은 추가하지 않았습니다.

- Android 다운로드: https://raw.githubusercontent.com/hse0722-debug/genie-android/main/genie-android.bin
- CRX 파일: https://github.com/hse0722-debug/genie-android/blob/main/genie-android.crx
- PC: 저장소의 Code → Download ZIP으로 소스를 받아 PC 설치 절차를 따릅니다. 또는 아래 배포 ZIP을 사용합니다.
- 배포 ZIP: https://github.com/hse0722-debug/genie-android/blob/main/genie_down_helper_github.zip

각자 설치한 브라우저의 계정과 진행 상태는 분리됩니다. 구글 시트만 공동으로 조회하며 계정 배정 서버는 없습니다.

Android 설치 참고: https://github.com/microsoft/amplifier-browser-bridge/blob/main/docs/ANDROID.md
Chrome 설치 지원 안내: https://support.google.com/chrome_webstore/answer/2664769?hl=ko
확장 프로그램의 외부 통신 안내: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

## 검증 범위

JavaScript 문법, CSV의 지정 셀 연결·쉼표·따옴표·줄바꿈 처리, 메시지 응답, 화면 표시, 저장, HTTP 오류·권한 오류·HTML 응답·빈 값·잘못된 시드·시간 초과 처리에 대한 모의 검증을 통과했습니다. 기존 processTask 실행 엔진 및 변경 대상이 아닌 4개 파일과의 동일성도 확인했습니다. Android 패키지의 CRX3 헤더·확장 ID·RSA 서명과 내부 ZIP 파일 목록도 검증했습니다.

일반 시트 내보내기 주소는 HTTP 401이었지만, 아이폰 최신 코드의 웹 게시 CSV 주소는 로그인 없이 HTTP 200으로 정상 조회되었습니다. 동일 게시 주소로 수정하고 실제 응답의 C3·D3 이름과 C4·D4 숫자 시드 해석을 검증했습니다. 실제 확장 프로그램 브라우저에서의 지니 로그인·좋아요·결제·다운로드와 모바일 호환은 실행 검증하지 않았습니다.


사용 중인 게시 CSV: https://docs.google.com/spreadsheets/d/e/2PACX-1vQbPI2-Jl21I-hHrIaPTaYIldo3-tJ-4Ml6aTiVZyc8q4az_ETGcOt2iY-E6suHUwbSbsIqXwtq3GGT/pub?output=csv
