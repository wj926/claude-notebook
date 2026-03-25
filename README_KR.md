# Claude Notebook

[English](README.md)

Jupyter Notebook 위에 **Notion 스타일 파일 브라우저**와 **터미널 관리 UI**를 추가하는 확장 — Claude Code Remote의 가볍고 셀프 호스팅 가능한 대안으로 설계되었습니다.

## 스크린샷

#### 파일 브라우저 (데스크톱 / 모바일)

<p>
  <img src="images/viewer_desktop.png" width="600">
  <img src="images/viewer_mobile.png" width="200">
</p>

- Notion 스타일 그리드 뷰 — 폴더/파일 아이콘 표시
- 사이드바 트리 탐색 — 폴더 확장/축소
- 반응형 레이아웃 — 모바일에서 햄버거 메뉴로 사이드바 토글

#### 터미널 관리자 (데스크톱 / 모바일)

<p>
  <img src="images/terminal_desktop.png" width="600">
  <img src="images/terminal_mobile.png" width="200">
</p>

- 상태 표시가 있는 멀티 터미널 사이드바
- VS Code 다크 테마의 xterm.js 터미널
- Claude Code와 대화형 상호작용을 위한 iMessage 스타일 채팅 뷰
- 파일 업로드 및 드래그 리사이즈 가능한 명령 입력 바

## 주요 기능

- **파일 브라우저**: Notion 스타일 인터페이스로 워크스페이스 탐색 — 구문 강조, 마크다운 렌더링, 이미지 미리보기, 인라인 편집
- **CSV 뷰어**: 컬럼 정렬, 필터링, 컬럼 크기 조절, 행 색상 지정, 셀 복사가 가능한 인터랙티브 테이블
- **터미널 관리자**: 여러 영구 터미널 세션 생성, 이름 변경, 설정, 전환
- **채팅 모드**: 터미널 출력을 ANSI 컬러 지원 대화 버블로 렌더링하는 iMessage 스타일 채팅 뷰
- **파일 업로드**: 파일/폴더 드래그 앤 드롭 업로드 — 파일명 충돌 자동 처리
- **서버 설정**: 터미널 이름, 시작 명령, 채팅 모드 설정, CSV 설정이 서버에 영구 저장
- **모바일 지원**: 터치 최적화 UI, 접이식 사이드바, 터미널 복사 지원의 완전 반응형 디자인
- **Claude Code 지원**: 별도의 터미널에서 여러 Claude Code 인스턴스를 동시에 실행
- **설정 불필요**: Jupyter의 `notebook_dir`을 워크스페이스 경로로 자동 사용

## 빠른 시작

```bash
# 리포지토리 클론
git clone https://github.com/Harry24k/claude-notebook.git
cd claude-notebook

# 의존성 설치 (Jupyter Notebook 6 및 Tornado 포함)
pip install -r requirements.txt

# 확장 등록
jupyter serverextension enable --py jupyter_ext --sys-prefix

# Jupyter Notebook 시작
jupyter notebook
```

그런 다음 브라우저에서 `http://localhost:8888/claude-notebook`를 방문합니다.

## 요구사항

- Python 3
- Jupyter Notebook 6.x
- Tornado

모든 의존성은 `requirements.txt`로 관리됩니다.

## 블로그 글

자세한 설정 가이드와 사용법은 블로그 글을 참조하세요:

- **English**: [Claude Notebook: A Self-Hosted Claude Code Remote Alternative via Jupyter Notebook](https://trustworthyai.co.kr/article/2026/claude-notebook-eng/)
- **한국어**: [Claude Notebook: Jupyter Notebook를 활용한 셀프 호스팅 Claude Code Remote 대안](https://trustworthyai.co.kr/article/2026/claude-notebook/)

## 라이선스

자세한 내용은 [LICENSE](LICENSE)를 참조하세요.
