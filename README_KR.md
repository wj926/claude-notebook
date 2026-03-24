# Workspace Viewer

[English](README.md)

Jupyter Notebook 위에 **Notion 스타일 파일 브라우저**와 **터미널 관리 UI**를 추가하는 확장 — Claude Code Remote의 가볍고 셀프 호스팅 가능한 대안으로 설계되었습니다.

## 주요 기능

- **파일 브라우저**: 구문 강조를 갖춘 깔끔한 Notion 스타일 인터페이스로 워크스페이스 탐색
- **터미널 관리자**: 여러 터미널 세션 생성, 이름 변경, 전환, 종료
- **Claude Code 지원**: 별도의 터미널에서 여러 Claude Code 인스턴스를 동시에 실행
- **설정 불필요**: Jupyter의 `notebook_dir`을 워크스페이스 경로로 자동 사용

## 빠른 시작

```bash
# 리포지토리 클론
git clone https://github.com/Harry24k/workspace-viewer.git
cd workspace-viewer

# 의존성 설치 (Jupyter Notebook 6 및 Tornado 포함)
pip install -r requirements.txt

# 확장 등록
jupyter serverextension enable --py jupyter_ext --sys-prefix

# Jupyter Notebook 시작
jupyter notebook
```

그런 다음 브라우저에서 `http://localhost:8888/workspace-viewer`를 방문합니다.

## 요구사항

- Python 3
- Jupyter Notebook 6.x
- Tornado

모든 의존성은 `requirements.txt`로 관리됩니다.

## 블로그 글

자세한 설정 가이드와 사용법은 블로그 글을 참조하세요:

- **English**: [Workspace Viewer: A Self-Hosted Claude Code Remote Alternative via Jupyter Notebook](https://trustworthyai.co.kr/article/2026/workspace-viewer-eng/)
- **한국어**: [Workspace Viewer: Jupyter Notebook를 활용한 셀프 호스팅 Claude Code Remote 대안](https://trustworthyai.co.kr/article/2026/workspace-viewer/)

## 라이선스

자세한 내용은 [LICENSE](LICENSE)를 참조하세요.
