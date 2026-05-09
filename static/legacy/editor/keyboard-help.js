/* === Claude Notebook — editor/keyboard-help.js ===
 *
 * Modal that lists every keyboard shortcut available inside the Notion
 * editor. Triggered by the "?" button in the preview toolbar (visible
 * for markdown files) and dismissed by clicking the overlay or pressing
 * Escape.
 */

import { escHtml } from '../core/utils.js';

const helpOverlay = document.getElementById('helpOverlay');
const previewHelp = document.getElementById('previewHelp');

const HELP_SECTIONS = [
    {
        title: '서식 (선택 후)',
        items: [
            ['⌘ B', '굵게'],
            ['⌘ I', '기울임'],
            ['⌘ U', '밑줄'],
            ['⌘ ⇧ S', '취소선'],
            ['⌘ E', '인라인 코드'],
            ['⌘ K', '링크'],
            ['⌘ ⇧ H', '마지막 색상 재적용'],
        ],
    },
    {
        title: '블록 타입 변환',
        items: [
            ['⌘ ⌥ 0', '텍스트'],
            ['⌘ ⌥ 1 / 2 / 3', '제목 1 / 2 / 3'],
            ['⌘ ⌥ 4', '할 일 목록'],
            ['⌘ ⌥ 5', '글머리 목록'],
            ['⌘ ⌥ 6', '번호 목록'],
            ['⌘ ⌥ 7', '토글'],
            ['⌘ ⌥ 8', '코드 블록'],
        ],
    },
    {
        title: '블록 조작',
        items: [
            ['⌘ D', '현재 블록 복제'],
            ['⌘ ⇧ ↑ / ↓', '블록 위/아래로 이동'],
            ['Tab / ⇧ Tab', '리스트 중첩 / 해제'],
            ['Esc', '블록 선택 모드'],
            ['⌘ A', '블록 전체 → 에디터 전체'],
            ['⌘ /', '블록 메뉴'],
            ['우클릭', '블록 메뉴'],
        ],
    },
    {
        title: '인라인 / 타이핑',
        items: [
            ['**굵게**', '굵게 (닫는 `**` 입력 시)'],
            ['*기울임*', '기울임'],
            ['`코드`', '인라인 코드'],
            ['~~취소~~', '취소선'],
            ['$수식$', '인라인 LaTeX'],
            ['URL + space', '자동 링크'],
        ],
    },
    {
        title: '블록 단축키 (줄 시작)',
        items: [
            ['# / ## / ### + space', '제목 1 / 2 / 3'],
            ['- / * / + + space', '글머리 목록'],
            ['1. + space', '번호 목록'],
            ['> / " + space', '인용'],
            ['[] / [x] + space', '할 일'],
            ['``` + space', '코드 블록'],
            ['--- + Enter', '구분선'],
        ],
    },
    {
        title: '피커',
        items: [
            ['/', '블록 삽입 슬래시 메뉴'],
            [':이름:', '이모지 선택'],
            ['@', '폴더 내 파일 참조 (이미지/비디오/오디오 인라인)'],
            ['⌘ S', '즉시 저장'],
            ['⌘ ⇧ F', '포커스 모드 토글'],
        ],
    },
];

function openHelpModal() {
    closeHelpModal();
    helpOverlay.innerHTML = `
        <div class="help-modal" role="dialog">
            <div class="help-header">
                <h3>키보드 단축키</h3>
                <button class="help-close" aria-label="닫기">&times;</button>
            </div>
            <div class="help-body">
                ${HELP_SECTIONS.map(s => `
                    <div class="help-section">
                        <div class="help-section-title">${escHtml(s.title)}</div>
                        <div class="help-items">
                            ${s.items.map(([k, v]) => `
                                <div class="help-row">
                                    <span class="help-key">${escHtml(k)}</span>
                                    <span class="help-desc">${escHtml(v)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    helpOverlay.classList.add('active');
    helpOverlay.querySelector('.help-close').addEventListener('click', closeHelpModal);
    helpOverlay.addEventListener('click', (e) => {
        if (e.target === helpOverlay) closeHelpModal();
    });
}

function closeHelpModal() {
    helpOverlay.classList.remove('active');
    helpOverlay.innerHTML = '';
}

export function initKeyboardHelp() {
    if (previewHelp) previewHelp.addEventListener('click', openHelpModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && helpOverlay.classList.contains('active')) {
            closeHelpModal();
        }
    });
}
