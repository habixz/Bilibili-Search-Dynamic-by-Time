// ==UserScript==
// @name         B站按时间查找动态
// @namespace    https://github.com/habixz
// @version      1.0.1
// @description  在 B 站动态页中按指定日期或时间范围查找动态，并在原页面高亮定位
// @author       habixz
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*/dynamic*
// @grant        none
// @run-at       document-start
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @note         修改维护：habixz
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'B站动态按时间查找';
    const STORAGE_KEY = 'bili_dynamic_time_search_settings_v1';
    const LAUNCHER_POSITION_KEY = 'bili_dynamic_time_search_launcher_position_v1';
    const CONFIG = {
        // 每轮滚动后等待页面继续加载的时长，单位毫秒；这里的值会直接参与实际等待，不再额外强制抬高下限。
        searchRequestDelay: 300,
        recycleHighWaterMark: 180,
        recycleLowWaterMark: 120,
        recycleManualKeepCount: 100,
        recycleViewportTopBuffer: 1800,
        recycleRangeContextCardBuffer: 6,
        recycleSpacerCollapseDelay: 1400,
        stuckScrollStep: 1200,
        stuckScrollRecoverDistance: 1800,
        wheelLikeScrollStep: 180,
        wheelLikeScrollDelay: 24,
        stuckScrollDetectionOffset: 12,
        scrollSettleDelay: 80,
        floatingUiViewportPadding: 8,
        dragStartThreshold: 4,
        launcherPanelGap: 12
    };

    function createDefaultFilters() {
        return {
            rangeStart: formatDateTimeValue(getStartOfTodayDateTimeParts()),
            rangeEnd: formatDateTimeValue(getNowDateTimeParts())
        };
    }

    function createEmptyRecycleStats() {
        return {
            spacerHeight: 0,
            recycledCardCount: 0,
            recycledHeight: 0
        };
    }

    const state = {
        filters: loadFilters(),
        launcherPosition: loadLauncherPosition(),
        uiWatcherStarted: false,
        searchRunning: false,
        activeSearchRange: null,
        dropdownEventsBound: false,
        activeDateTimeDropdown: null,
        lastFallbackScrollAt: 0,
        recycleCollapseTimerId: null,
        recycleContextContainer: null,
        recycleContextPageKey: location.href,
        recycleStats: createEmptyRecycleStats()
    };

    bootstrapUi();

    function bootstrapUi() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountUi, { once: true });
        } else {
            mountUi();
        }
    }

    function mountUi() {
        if (!document.body || state.uiWatcherStarted) {
            return;
        }

        ensureStyle();
        bindGlobalDateTimeDropdownEvents();
        ensureSearchUiMounted();
        window.setInterval(ensureSearchUiMounted, 1200);
        state.uiWatcherStarted = true;
    }

    function loadFilters() {
        const defaults = createDefaultFilters();
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return defaults;
            }
            const mergedFilters = {
                ...defaults,
                ...(JSON.parse(raw) || {})
            };
            return {
                rangeStart: normalizeFilterValue(mergedFilters.rangeStart, 'start', defaults.rangeStart),
                rangeEnd: normalizeFilterValue(mergedFilters.rangeEnd, 'end', defaults.rangeEnd)
            };
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取设置失败，已回退到默认值`, error);
            return defaults;
        }
    }

    function saveFilters() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.filters));
    }

    function loadLauncherPosition() {
        try {
            const raw = localStorage.getItem(LAUNCHER_POSITION_KEY);
            if (!raw) {
                return null;
            }

            const parsedPosition = JSON.parse(raw);
            const left = Number(parsedPosition?.left);
            const top = Number(parsedPosition?.top);
            if (!Number.isFinite(left) || !Number.isFinite(top)) {
                return null;
            }

            return {
                left: Math.round(left),
                top: Math.round(top)
            };
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取按钮位置失败，已回退到默认位置`, error);
            return null;
        }
    }

    function saveLauncherPosition(position) {
        if (!position) {
            return;
        }

        const normalizedPosition = {
            left: Math.round(position.left),
            top: Math.round(position.top)
        };

        state.launcherPosition = normalizedPosition;
        try {
            localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify(normalizedPosition));
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 保存按钮位置失败`, error);
        }
    }

    function ensureStyle() {
        if (document.getElementById('bili-dynamic-time-search-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'bili-dynamic-time-search-style';
        style.textContent = `
            .bdt-progress[hidden],
            .bdt-panel[hidden] {
                display: none !important;
            }
            .bdt-launcher {
                position: fixed;
                right: 24px;
                bottom: 118px;
                z-index: 2147483645;
                width: 52px;
                height: 52px;
                border: none;
                border-radius: 50%;
                background: linear-gradient(135deg, #00aeec 0%, #5c7cff 100%);
                color: #fff;
                font-size: 24px;
                cursor: grab;
                user-select: none;
                box-shadow: 0 12px 28px rgba(0, 174, 236, 0.28);
            }
            .bdt-launcher.bdt-dragging {
                cursor: grabbing;
            }
            .bdt-panel {
                position: fixed;
                right: 24px;
                bottom: 182px;
                z-index: 2147483645;
                width: max-content;
                max-width: calc(100vw - 32px);
                padding: 16px;
                border-radius: 16px;
                background: #fff;
                color: #18191c;
                box-shadow: 0 20px 48px rgba(0, 0, 0, 0.16);
                border: 1px solid #eef1f5;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .bdt-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 14px;
                cursor: grab;
                user-select: none;
            }
            .bdt-panel.bdt-dragging .bdt-header {
                cursor: grabbing;
            }
            .bdt-title {
                margin: 0;
                font-size: 16px;
                font-weight: 700;
            }
            .bdt-close-btn {
                border: none;
                background: transparent;
                color: #61666d;
                font-size: 18px;
                cursor: pointer;
            }
            .bdt-label {
                display: block;
                margin-bottom: 6px;
                font-size: 13px;
                color: #61666d;
            }
            .bdt-range-stack {
                display: flex;
                flex-direction: column;
                gap: 12px;
                align-items: flex-start;
            }
            .bdt-time-group {
                display: inline-block;
                width: fit-content;
                max-width: 100%;
                padding: 10px;
                border: 1px solid #eef1f5;
                border-radius: 12px;
                background: #fafbfc;
                overflow: visible;
            }
            .bdt-time-group-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 8px;
            }
            .bdt-time-group-title {
                margin: 0;
                font-size: 13px;
                font-weight: 700;
                color: #18191c;
            }
            .bdt-time-group-actions {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                flex: 0 0 auto;
            }
            .bdt-time-group-icon-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: #61666d;
                font-size: 14px;
                line-height: 1;
                cursor: pointer;
                flex: 0 0 auto;
            }
            .bdt-time-group-transfer-icon {
                display: inline-block;
                transform: translateY(-2px);
            }
            .bdt-time-group-icon-btn:hover {
                background: rgba(97, 102, 109, 0.1);
                color: #18191c;
            }
            .bdt-duration {
                min-width: 100%;
                padding: 10px 12px;
                border-radius: 12px;
                background: #f6f7fb;
                color: #61666d;
                box-sizing: border-box;
            }
            .bdt-duration.bdt-duration-error {
                background: rgba(255, 77, 79, 0.12);
                color: #c43042;
            }
            .bdt-duration-label {
                font-size: 12px;
            }
            .bdt-duration-value {
                margin-top: 4px;
                font-size: 14px;
                font-weight: 700;
                color: #18191c;
            }
            .bdt-duration.bdt-duration-error .bdt-duration-value {
                color: #c43042;
            }
            .bdt-time-row {
                display: flex;
                align-items: center;
                flex-wrap: nowrap;
                gap: 3px;
                overflow: visible;
            }
            .bdt-time-field {
                display: inline-flex;
                align-items: center;
                gap: 3px;
                flex: 0 0 auto;
                position: relative;
            }
            .bdt-time-unit {
                font-size: 11px;
                color: #61666d;
                user-select: none;
            }
            .bdt-date-picker-btn {
                border: 1px solid #d9dde4;
                border-radius: 10px;
                background: #fff;
                color: #18191c;
                width: 34px;
                height: 34px;
                padding: 0;
                font-size: 15px;
                line-height: 1;
                cursor: pointer;
                flex: 0 0 auto;
            }
            .bdt-date-picker-proxy {
                position: absolute;
                opacity: 0;
                pointer-events: none;
                width: 0;
                height: 0;
            }
            .bdt-time-separator {
                color: #61666d;
                font-size: 13px;
                line-height: 1;
                flex: 0 0 auto;
                user-select: none;
            }
            .bdt-date-time-gap {
                width: 6px;
                flex: 0 0 auto;
            }
            .bdt-input {
                width: 100%;
                box-sizing: border-box;
                padding: 10px 12px;
                border: 1px solid #d9dde4;
                border-radius: 10px;
                font-size: 13px;
                outline: none;
            }
            .bdt-time-field .bdt-input {
                width: 44px;
                padding: 7px 8px;
                text-align: center;
            }
            .bdt-time-field-year .bdt-input {
                width: 60px;
            }
            .bdt-time-field-dropdownable .bdt-input {
                cursor: pointer;
            }
            .bdt-time-dropdown {
                position: fixed;
                z-index: 2147483646;
                max-height: 220px;
                overflow-y: auto;
                overscroll-behavior: contain;
                padding: 3px;
                border: 1px solid #d9dde4;
                border-radius: 10px;
                background: #fff;
                box-shadow: 0 14px 32px rgba(0, 0, 0, 0.16);
                box-sizing: border-box;
                scrollbar-width: thin;
                scrollbar-color: rgba(97, 102, 109, 0.5) transparent;
            }
            .bdt-time-dropdown[hidden] {
                display: none !important;
            }
            .bdt-time-dropdown::-webkit-scrollbar {
                width: 6px;
            }
            .bdt-time-dropdown::-webkit-scrollbar-track {
                background: transparent;
                margin: 4px 0;
            }
            .bdt-time-dropdown::-webkit-scrollbar-thumb {
                border-radius: 999px;
                background: rgba(97, 102, 109, 0.5);
            }
            .bdt-time-dropdown::-webkit-scrollbar-thumb:hover {
                background: rgba(97, 102, 109, 0.7);
            }
            .bdt-time-dropdown-option {
                width: 100%;
                border: none;
                border-radius: 8px;
                background: transparent;
                color: #18191c;
                padding: 7px 6px;
                text-align: center;
                font-size: 13px;
                cursor: pointer;
                box-sizing: border-box;
            }
            .bdt-time-dropdown-option.is-active {
                background: linear-gradient(135deg, rgba(0, 174, 236, 0.16) 0%, rgba(92, 124, 255, 0.16) 100%);
                color: #0f4fcf;
                font-weight: 700;
            }
            .bdt-time-dropdown-option:hover {
                background: #f2f4f7;
            }
            .bdt-actions {
                display: flex;
                gap: 8px;
                margin-top: 12px;
                flex-wrap: wrap;
            }
            .bdt-actions-search {
                margin-top: 14px;
            }
            .bdt-actions-recycle {
                margin-top: 16px;
            }
            .bdt-btn {
                border: none;
                border-radius: 10px;
                padding: 10px 12px;
                color: #fff;
                cursor: pointer;
                font-size: 14px;
            }
            .bdt-btn-primary {
                background: linear-gradient(135deg, #00aeec 0%, #5c7cff 100%);
            }
            .bdt-btn-danger {
                background: linear-gradient(135deg, #ff6a6a 0%, #ff4d4f 100%);
            }
            .bdt-btn-secondary {
                background: linear-gradient(135deg, #8b95a7 0%, #61666d 100%);
            }
            .bdt-progress {
                margin-top: 12px;
                padding: 12px;
                border-radius: 12px;
                background: #eef6ff;
                border: 1px solid #d8e8ff;
                font-size: 13px;
                color: #4b5563;
                line-height: 1.8;
            }
            .bdt-recycle-summary {
                margin-top: 8px;
                padding: 12px;
                border-radius: 12px;
                background: #f6f7fb;
                font-size: 13px;
                color: #61666d;
                line-height: 1.8;
            }
            .bdt-recycle-spacer {
                width: 100%;
                min-height: 0;
                pointer-events: none;
            }
            .bdt-recycle-banner {
                width: 100%;
                box-sizing: border-box;
                margin-bottom: 12px;
                padding: 10px 12px;
                border-radius: 12px;
                border: 1px solid rgba(0, 174, 236, 0.18);
                background: linear-gradient(135deg, rgba(0, 174, 236, 0.08) 0%, rgba(92, 124, 255, 0.08) 100%);
                color: #0f4fcf;
                font-size: 13px;
                line-height: 1.6;
                box-shadow: 0 6px 18px rgba(15, 79, 207, 0.08);
            }
            .bdt-recycle-banner[hidden] {
                display: none !important;
            }
            .bdt-card-time-pass-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                margin-left: 6px;
                padding: 0;
                border: 1px solid rgba(0, 0, 0, 0.92);
                border-radius: 50%;
                background: rgba(24, 25, 28, 0.96);
                color: #ffffff;
                font-size: 12px;
                line-height: 1;
                vertical-align: middle;
                cursor: pointer;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.16);
            }
            .bdt-card-time-pass-btn:hover {
                background: rgba(255, 255, 255, 0.98);
                color: #18191c;
            }
            #bdt-toast-wrap {
                position: fixed;
                top: 72px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                gap: 8px;
                pointer-events: none;
            }
            .bdt-toast {
                min-width: 220px;
                max-width: min(560px, calc(100vw - 32px));
                padding: 10px 14px;
                border-radius: 12px;
                background: rgba(24, 25, 28, 0.92);
                color: #fff;
                font-size: 13px;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
            }
            .bdt-toast-success {
                background: rgba(30, 122, 67, 0.95);
            }
            .bdt-toast-error {
                background: rgba(196, 48, 66, 0.96);
            }
        `;
        document.head.appendChild(style);
    }

    function ensureSearchUiMounted() {
        if (!isDynamicSearchPage()) {
            return;
        }
        syncRecycleContext();
        if (!document.getElementById('bdt-launcher')) {
            createSearchLauncher();
        }
        if (!document.getElementById('bdt-panel')) {
            createSearchPanel();
        }
        ensureDynamicCardTimeButtons();
    }

    function createSearchLauncher() {
        const launcher = document.createElement('button');
        launcher.id = 'bdt-launcher';
        launcher.className = 'bdt-launcher';
        launcher.type = 'button';
        launcher.title = `${SCRIPT_NAME} 时间查找`;
        launcher.textContent = '📅';
        launcher.addEventListener('click', handleLauncherClick);
        document.body.appendChild(launcher);
        if (state.launcherPosition) {
            restoreLauncherPosition(launcher);
        } else {
            // 默认定位也立即转成 left/top 固定坐标，并走一次边界收敛，
            // 这样即使右侧存在浏览器滚动条，也不会把悬浮球挤进滚动条区域。
            pinFloatingElementPosition(launcher);
        }
        bindFloatingDrag(launcher, {
            dragHandle: launcher,
            markClickSuppressedAfterDrag: true,
            onPositionChange() {
                syncPanelPositionToLauncher(false);
            },
            onDragEnd(currentLauncher) {
                persistLauncherPositionFromElement(currentLauncher);
            }
        });
    }

    function createSearchPanel() {
        const panel = document.createElement('div');
        panel.id = 'bdt-panel';
        panel.className = 'bdt-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <div class="bdt-header">
                <h3 class="bdt-title">📅 动态时间查找</h3>
                <button id="bdt-close" class="bdt-close-btn" type="button">✕</button>
            </div>
            <div>
                <div class="bdt-range-stack">
                    ${createDateTimeGroupMarkup('end', '结束')}
                    ${createDateTimeGroupMarkup('start', '开始')}
                    <div class="bdt-duration" id="bdt-duration">
                        <div class="bdt-duration-label">时长</div>
                        <div class="bdt-duration-value" id="bdt-duration-value">--</div>
                    </div>
                </div>
            </div>
            <div class="bdt-actions bdt-actions-search">
                <button class="bdt-btn bdt-btn-primary" id="bdt-start" type="button" style="flex:1;">开始查找</button>
                <button class="bdt-btn bdt-btn-danger" id="bdt-stop" type="button" style="flex:1;">停止查找</button>
            </div>
            <div class="bdt-actions bdt-actions-recycle">
                <button class="bdt-btn bdt-btn-secondary" id="bdt-recycle" type="button" style="flex:1;">回收顶部动态</button>
            </div>
            <div class="bdt-recycle-summary" id="bdt-recycle-summary">
                <div>已回收：<span id="bdt-recycle-count">0</span> 条</div>
                <div>回收高度：<span id="bdt-recycle-height">0</span> px</div>
            </div>
            <div class="bdt-progress" id="bdt-progress" hidden>
                <div>已滚动：<span id="bdt-progress-pages">0</span> 次</div>
                <div>本次命中：<span id="bdt-progress-count">0</span> 条</div>
                <div>当前翻至：<span id="bdt-progress-current">等待中...</span></div>
            </div>
        `;

        document.body.appendChild(panel);
        bindSearchPanelEvents();
        bindFloatingDrag(panel, {
            dragHandle: panel.querySelector('.bdt-header'),
            cancelSelector: 'button, input, select, textarea, label'
        });
    }

    function bindSearchPanelEvents() {
        document.getElementById('bdt-close')?.addEventListener('click', () => {
            const panel = document.getElementById('bdt-panel');
            if (panel) {
                panel.hidden = true;
            }
        });

        bindDateTimeGroupEvents('start');
        bindDateTimeGroupEvents('end');

        document.getElementById('bdt-start')?.addEventListener('click', () => {
            void startUserDynamicSearch();
        });

        document.getElementById('bdt-stop')?.addEventListener('click', () => {
            stopUserDynamicSearch(true);
        });

        document.getElementById('bdt-recycle')?.addEventListener('click', () => {
            handleManualRecycle();
        });
    }

    function toggleSearchPanel() {
        const panel = document.getElementById('bdt-panel');
        if (!panel) {
            return;
        }
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            syncUiFromState();
            // 每次重新打开时都按当前按钮位置重新贴靠，避免按钮拖走后面板还停在旧位置。
            syncPanelPositionToLauncher(true);
        }
    }

    function handleLauncherClick(event) {
        const launcher = event.currentTarget;
        if (launcher?.dataset?.suppressClickAfterDrag === 'true') {
            // 拖拽结束后的这一次 click 是浏览器补发的“抬手点击”，这里吞掉，避免拖完面板反而又触发开关。
            launcher.dataset.suppressClickAfterDrag = 'false';
            return;
        }
        toggleSearchPanel();
    }

    function bindFloatingDrag(element, options = {}) {
        if (!element || element.dataset.dragBound === 'true') {
            return;
        }

        const dragHandle = options.dragHandle || element;
        if (!dragHandle) {
            return;
        }

        let dragSession = null;
        let previousUserSelect = '';

        const handleMouseMove = (event) => {
            if (!dragSession) {
                return;
            }

            const deltaX = event.clientX - dragSession.startX;
            const deltaY = event.clientY - dragSession.startY;
            const movedEnough = Math.abs(deltaX) >= CONFIG.dragStartThreshold || Math.abs(deltaY) >= CONFIG.dragStartThreshold;
            if (!dragSession.moved && !movedEnough) {
                return;
            }

            dragSession.moved = true;
            const nextLeft = dragSession.originLeft + deltaX;
            const nextTop = dragSession.originTop + deltaY;
            setFloatingElementPosition(element, nextLeft, nextTop);
            if (typeof options.onPositionChange === 'function') {
                options.onPositionChange(element);
            }
        };

        const finishDrag = () => {
            if (!dragSession) {
                return;
            }

            document.removeEventListener('mousemove', handleMouseMove, true);
            document.removeEventListener('mouseup', finishDrag, true);
            element.classList.remove('bdt-dragging');
            document.body.style.userSelect = previousUserSelect;

            if (dragSession.moved && options.markClickSuppressedAfterDrag) {
                element.dataset.suppressClickAfterDrag = 'true';
            }

            if (dragSession.moved && typeof options.onDragEnd === 'function') {
                options.onDragEnd(element);
            }

            dragSession = null;
        };

        dragHandle.addEventListener('mousedown', (event) => {
            if (event.button !== 0) {
                return;
            }
            if (options.cancelSelector && event.target?.closest?.(options.cancelSelector)) {
                return;
            }

            const rect = pinFloatingElementPosition(element);
            dragSession = {
                startX: event.clientX,
                startY: event.clientY,
                originLeft: rect.left,
                originTop: rect.top,
                moved: false
            };

            previousUserSelect = document.body.style.userSelect;
            document.body.style.userSelect = 'none';
            element.classList.add('bdt-dragging');
            document.addEventListener('mousemove', handleMouseMove, true);
            document.addEventListener('mouseup', finishDrag, true);

            // 阻止浏览器把拖拽起手识别成文本选中或按钮聚焦，保证拖动过程更稳定。
            event.preventDefault();
        });

        element.dataset.dragBound = 'true';
    }

    function pinFloatingElementPosition(element) {
        const rect = element.getBoundingClientRect();
        setFloatingElementPosition(element, rect.left, rect.top);
        return element.getBoundingClientRect();
    }

    function setFloatingElementPosition(element, left, top) {
        const { clampedLeft, clampedTop } = clampFloatingPosition(left, top, element);
        element.style.left = `${clampedLeft}px`;
        element.style.top = `${clampedTop}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.dataset.positionPinned = 'true';
    }

    function clampFloatingElementToViewport(element) {
        if (!element || element.hidden) {
            return;
        }

        if (element.dataset.positionPinned === 'true') {
            const rect = element.getBoundingClientRect();
            setFloatingElementPosition(element, rect.left, rect.top);
        }
    }

    function restoreLauncherPosition(element) {
        if (!element || !state.launcherPosition) {
            return;
        }

        // 恢复历史位置时仍会再次经过视口边界收敛，避免分辨率变化后按钮跑到可视区域外。
        setFloatingElementPosition(element, state.launcherPosition.left, state.launcherPosition.top);
    }

    function persistLauncherPositionFromElement(element) {
        if (!element || element.id !== 'bdt-launcher') {
            return;
        }

        const rect = element.getBoundingClientRect();
        saveLauncherPosition({
            left: rect.left,
            top: rect.top
        });
    }

    function syncPanelPositionToLauncher(forceReset = false) {
        const launcher = document.getElementById('bdt-launcher');
        const panel = document.getElementById('bdt-panel');
        if (!launcher || !panel || panel.hidden) {
            return;
        }

        const launcherRect = launcher.getBoundingClientRect();
        const gap = Math.max(0, Number(CONFIG.launcherPanelGap) || 0);

        // 默认让面板贴着按钮上方出现；如果按钮已经靠近顶部，就改为显示在按钮下方。
        const preferredLeft = launcherRect.right - panel.offsetWidth;
        const preferredTop = launcherRect.top - panel.offsetHeight - gap;
        const fallbackTop = launcherRect.bottom + gap;
        const nextTop = preferredTop >= CONFIG.floatingUiViewportPadding ? preferredTop : fallbackTop;

        setFloatingElementPosition(panel, preferredLeft, nextTop);
    }

    function clampFloatingPosition(left, top, element) {
        const padding = Math.max(0, Number(CONFIG.floatingUiViewportPadding) || 0);
        const viewportWidth = getFloatingViewportWidth();
        const viewportHeight = getFloatingViewportHeight();
        const maxLeft = Math.max(padding, viewportWidth - element.offsetWidth - padding);
        const maxTop = Math.max(padding, viewportHeight - element.offsetHeight - padding);
        return {
            clampedLeft: Math.min(maxLeft, Math.max(padding, Math.round(left))),
            clampedTop: Math.min(maxTop, Math.max(padding, Math.round(top)))
        };
    }

    function getFloatingViewportWidth() {
        // `clientWidth` 会排除浏览器右侧纵向滚动条占用的空间，
        // 用它来约束悬浮元素，能避免按钮被滚动条盖住一小截。
        return Math.max(0, document.documentElement?.clientWidth || window.innerWidth || 0);
    }

    function getFloatingViewportHeight() {
        // 高度侧同理优先取可用视口高度，避免底部滚动条或视口变化时定位越界。
        return Math.max(0, document.documentElement?.clientHeight || window.innerHeight || 0);
    }

    function syncUiFromState() {
        syncDateTimeGroupFromValue('start', state.filters.rangeStart);
        syncDateTimeGroupFromValue('end', state.filters.rangeEnd);
        updateDurationDisplay();
        updateRecycleStatusDisplay();
    }

    function updateFiltersFromUi() {
        state.filters.rangeStart = readDateTimeGroupValue('start');
        state.filters.rangeEnd = readDateTimeGroupValue('end');
        updateDurationDisplay();
    }

    async function startUserDynamicSearch() {
        if (!isDynamicSearchPage()) {
            showToast('当前页面不支持时间查找。', 'error');
            return;
        }

        updateFiltersFromUi();
        saveFilters();

        const range = buildDateRangeFromFilters(state.filters);
        if (!range) {
            return;
        }

        // 配置值和实际行为保持一致，只做最基础的非负整数兜底，方便后续按站点表现继续微调。
        const requestDelay = Math.max(0, Math.round(Number(CONFIG.searchRequestDelay) || 0));

        stopUserDynamicSearch(false);
        state.searchRunning = true;
        state.activeSearchRange = range;
        clearHighlightedDynamics();
        updateSearchProgress(0, 0, '初始化中...');
        toggleSearchProgress(true);

        try {
            let scrollCount = 0;
            let retries = 0;
            let lastTrackedDynamicCount = getTotalTrackedDynamicCount();

            while (state.searchRunning) {
                const cards = getDynamicCards();
                const analysis = analyzeDynamicCards(cards, range);
                const trackedDynamicCount = getTotalTrackedDynamicCount(cards.length);
                const currentDateText = analysis.oldestDate
                    ? formatDateInfoDisplay(analysis.oldestDate)
                    : '未知';

                updateSearchProgress(scrollCount, analysis.matches.length, currentDateText);

                if (range.startMs) {
                    if (analysis.reachedStartBoundary) {
                        if (analysis.matches.length > 0) {
                            highlightMatchedDynamics(analysis.matches);
                            showToast(`已定位到 ${analysis.matches.length} 条匹配动态`, 'success');
                        } else {
                            if (analysis.oldestCard) {
                                analysis.oldestCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                            showToast('已经滚动超过目标开始时间，但当前页面附近没有找到匹配动态。', 'error');
                        }
                        break;
                    }
                } else if (analysis.matches.length > 0) {
                    highlightMatchedDynamics(analysis.matches);
                    showToast(`已在当前页面定位到 ${analysis.matches.length} 条匹配动态。`, 'success');
                    break;
                }

                if (trackedDynamicCount > lastTrackedDynamicCount) {
                    lastTrackedDynamicCount = trackedDynamicCount;
                    retries = 0;
                } else {
                    retries += 1;
                }

                if (retries >= 10) {
                    showToast('连续多次没有加载出新动态，已停止搜索。', 'error');
                    break;
                }

                maybeRecycleDynamicCards();
                scrollCount += 1;
                await performSearchScroll();
                await sleep(requestDelay);
            }
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 搜索失败`, error);
            showToast(`查找失败：${error.message || '未知错误'}`, 'error');
        } finally {
            stopUserDynamicSearch(false);
        }
    }

    function stopUserDynamicSearch(showTip) {
        state.searchRunning = false;
        state.activeSearchRange = null;
        toggleSearchProgress(false);
        if (showTip) {
            showToast('已停止查找。', 'success');
        }
    }

    function toggleSearchProgress(visible) {
        const progress = document.getElementById('bdt-progress');
        if (progress) {
            progress.hidden = !visible;
        }
    }

    function updateSearchProgress(pageCount, resultCount, currentDateText) {
        const pages = document.getElementById('bdt-progress-pages');
        const count = document.getElementById('bdt-progress-count');
        const current = document.getElementById('bdt-progress-current');
        if (pages) {
            pages.textContent = String(pageCount);
        }
        if (count) {
            count.textContent = String(resultCount);
        }
        if (current) {
            current.textContent = currentDateText;
        }
    }

    function formatDateInfoDisplay(dateInfo) {
        return `${dateInfo.year}年${dateInfo.month}月${dateInfo.day}日 ${dateInfo.hour}:${dateInfo.minute}:${dateInfo.second}`;
    }

    function updateRecycleStatusDisplay(options = {}) {
        if (!options.skipContextSync) {
            syncRecycleContext();
        }
        const recycleCount = document.getElementById('bdt-recycle-count');
        const recycleHeight = document.getElementById('bdt-recycle-height');
        if (recycleCount) {
            recycleCount.textContent = String(state.recycleStats.recycledCardCount);
        }
        if (recycleHeight) {
            recycleHeight.textContent = String(Math.round(state.recycleStats.recycledHeight));
        }
        renderRecycleBanner();
    }

    function handleManualRecycle() {
        const recycleResult = maybeRecycleDynamicCards({ force: true });
        if (recycleResult.recycledCount > 0) {
            showToast(`已回收 ${recycleResult.recycledCount} 条顶部动态。`, 'success');
            return;
        }
        showToast('当前视口上方没有可回收的动态。');
    }

    function syncRecycleContext(cards = getDynamicCards()) {
        const currentPageKey = location.href;
        const currentContainer = cards[0]?.parentElement || document.querySelector('.bili-dyn-item')?.parentElement || null;
        const pageChanged = state.recycleContextPageKey !== currentPageKey;
        const staleContainer = Boolean(state.recycleContextContainer && !state.recycleContextContainer.isConnected);
        const containerChanged = Boolean(
            state.recycleContextContainer
            && currentContainer
            && state.recycleContextContainer !== currentContainer
        );

        if (pageChanged || staleContainer || containerChanged) {
            // 只要页面上下文或列表容器变了，就把旧页面积累的回收统计和占位块清掉，避免污染新列表。
            resetRecycleState({ updateDisplay: false });
        }

        state.recycleContextPageKey = currentPageKey;
        state.recycleContextContainer = currentContainer;
    }

    function resetRecycleState(options = {}) {
        const shouldUpdateDisplay = options.updateDisplay !== false;
        if (state.recycleCollapseTimerId) {
            window.clearTimeout(state.recycleCollapseTimerId);
            state.recycleCollapseTimerId = null;
        }

        document.getElementById('bdt-recycle-spacer')?.remove();
        document.getElementById('bdt-recycle-banner')?.remove();

        state.recycleContextContainer = null;
        state.recycleContextPageKey = location.href;
        state.recycleStats = createEmptyRecycleStats();

        if (shouldUpdateDisplay) {
            updateRecycleStatusDisplay({ skipContextSync: true });
        }
    }

    function maybeRecycleDynamicCards(options = {}) {
        const cards = getDynamicCards();
        syncRecycleContext(cards);
        if (!cards.length) {
            return { recycledCount: 0, recycledHeight: 0 };
        }

        const forceRecycle = Boolean(options.force);
        if (!forceRecycle && cards.length <= CONFIG.recycleHighWaterMark) {
            return { recycledCount: 0, recycledHeight: 0 };
        }

        const targetRemainingCount = forceRecycle
            ? Math.min(CONFIG.recycleManualKeepCount, cards.length)
            : CONFIG.recycleLowWaterMark;
        const maxRecycleCount = Math.max(0, cards.length - targetRemainingCount);
        if (maxRecycleCount <= 0) {
            return { recycledCount: 0, recycledHeight: 0 };
        }

        const recyclableCards = collectRecyclableDynamicCards(cards, maxRecycleCount);
        if (!recyclableCards.length) {
            return { recycledCount: 0, recycledHeight: 0 };
        }

        const recycleSpacer = ensureRecycleSpacer(cards[0]);
        if (!recycleSpacer) {
            return { recycledCount: 0, recycledHeight: 0 };
        }

        let recycledHeight = 0;
        recyclableCards.forEach((card) => {
            recycledHeight += getDynamicCardOuterHeight(card);
            card.remove();
        });

        state.recycleStats.recycledCardCount += recyclableCards.length;
        state.recycleStats.recycledHeight += recycledHeight;
        state.recycleStats.spacerHeight += recycledHeight;
        recycleSpacer.style.height = `${Math.round(state.recycleStats.spacerHeight)}px`;
        updateRecycleStatusDisplay();
        scheduleRecycleSpacerCollapse();

        return {
            recycledCount: recyclableCards.length,
            recycledHeight
        };
    }

    function collectRecyclableDynamicCards(cards, maxRecycleCount) {
        const recyclableCards = [];
        const recycleBoundary = getScrollTop() - CONFIG.recycleViewportTopBuffer;
        const protectedRange = state.searchRunning ? state.activeSearchRange : null;
        if (recycleBoundary <= 0) {
            return recyclableCards;
        }

        for (const card of cards) {
            if (recyclableCards.length >= maxRecycleCount) {
                break;
            }
            if (card.classList.contains('bdt-time-match')) {
                break;
            }
            if (getDynamicCardDocumentBottom(card) >= recycleBoundary) {
                break;
            }
            if (protectedRange) {
                const dateInfo = extractDateInfo(card);
                if (dateInfo && isDateInfoInRange(dateInfo, protectedRange)) {
                    // 在查找区间上方额外保留一小段较新的动态，方便用户感知目标区间的上下文和时间位置。
                    const contextKeepCount = Math.min(CONFIG.recycleRangeContextCardBuffer, recyclableCards.length);
                    if (contextKeepCount > 0) {
                        recyclableCards.splice(-contextKeepCount, contextKeepCount);
                    }
                    break;
                }
            }
            recyclableCards.push(card);
        }

        return recyclableCards;
    }

    function ensureRecycleSpacer(referenceCard) {
        const container = referenceCard?.parentElement;
        if (!container) {
            return null;
        }

        let recycleSpacer = document.getElementById('bdt-recycle-spacer');
        if (!recycleSpacer) {
            recycleSpacer = document.createElement('div');
            recycleSpacer.id = 'bdt-recycle-spacer';
            recycleSpacer.className = 'bdt-recycle-spacer';
        }
        if (recycleSpacer.parentElement !== container) {
            container.insertBefore(recycleSpacer, referenceCard);
        } else if (referenceCard.previousElementSibling !== recycleSpacer) {
            container.insertBefore(recycleSpacer, referenceCard);
        }
        recycleSpacer.style.height = `${Math.round(state.recycleStats.spacerHeight)}px`;
        return recycleSpacer;
    }

    function scheduleRecycleSpacerCollapse() {
        if (state.recycleCollapseTimerId) {
            window.clearTimeout(state.recycleCollapseTimerId);
        }
        if (state.recycleStats.spacerHeight <= 0) {
            renderRecycleBanner();
            return;
        }
        state.recycleCollapseTimerId = window.setTimeout(() => {
            state.recycleCollapseTimerId = null;
            collapseRecycleSpacer();
        }, CONFIG.recycleSpacerCollapseDelay);
    }

    function collapseRecycleSpacer() {
        const collapseHeight = Math.round(state.recycleStats.spacerHeight);
        if (collapseHeight <= 0) {
            renderRecycleBanner();
            return;
        }

        const recycleSpacer = document.getElementById('bdt-recycle-spacer');
        const compensatedScrollDistance = Math.min(collapseHeight, Math.max(0, getScrollTop()));

        // 先把占位清空，再补偿滚动距离，尽量减少内容瞬间错位。
        state.recycleStats.spacerHeight = 0;
        if (recycleSpacer) {
            recycleSpacer.remove();
        }
        if (compensatedScrollDistance > 0) {
            window.scrollBy({ top: -compensatedScrollDistance, behavior: 'auto' });
        }
        updateRecycleStatusDisplay();
    }

    function renderRecycleBanner() {
        const recycleBanner = ensureRecycleBanner();
        if (!recycleBanner) {
            return;
        }
        if (state.recycleStats.recycledCardCount <= 0 || state.recycleStats.spacerHeight > 0) {
            recycleBanner.hidden = true;
            return;
        }
        recycleBanner.hidden = false;
        recycleBanner.textContent = `已隐藏 ${state.recycleStats.recycledCardCount} 条较新的动态。`;
    }

    function ensureRecycleBanner() {
        const container = getDynamicListContainer();
        if (!container) {
            return null;
        }

        let recycleBanner = document.getElementById('bdt-recycle-banner');
        if (!recycleBanner) {
            recycleBanner = document.createElement('div');
            recycleBanner.id = 'bdt-recycle-banner';
            recycleBanner.className = 'bdt-recycle-banner';
            recycleBanner.hidden = true;
        }

        const firstCard = container.querySelector('.bili-dyn-item');
        if (recycleBanner.parentElement !== container) {
            if (firstCard) {
                container.insertBefore(recycleBanner, firstCard);
            } else {
                container.appendChild(recycleBanner);
            }
        } else if (firstCard && recycleBanner.nextElementSibling !== firstCard) {
            container.insertBefore(recycleBanner, firstCard);
        }

        return recycleBanner;
    }

    function getDynamicListContainer() {
        return document.getElementById('bdt-recycle-banner')?.parentElement
            || document.getElementById('bdt-recycle-spacer')?.parentElement
            || document.querySelector('.bili-dyn-item')?.parentElement
            || null;
    }

    function getDynamicCardOuterHeight(card) {
        const computedStyle = window.getComputedStyle(card);
        const marginTop = parseFloat(computedStyle.marginTop) || 0;
        const marginBottom = parseFloat(computedStyle.marginBottom) || 0;
        return card.getBoundingClientRect().height + marginTop + marginBottom;
    }

    function getDynamicCardDocumentBottom(card) {
        const cardRect = card.getBoundingClientRect();
        return getScrollTop() + cardRect.bottom;
    }

    function getTotalTrackedDynamicCount(visibleCardCount = getDynamicCards().length) {
        return visibleCardCount + state.recycleStats.recycledCardCount;
    }

    async function performSearchScroll() {
        await performWheelLikeScroll(-CONFIG.stuckScrollRecoverDistance);
        await sleep(CONFIG.scrollSettleDelay);
        performPrimarySearchScroll();
        await sleep(CONFIG.scrollSettleDelay);

        state.lastFallbackScrollAt = Date.now();
    }

    async function performWheelLikeScroll(distance) {
        const direction = distance < 0 ? -1 : 1;
        let remainingDistance = Math.abs(distance);
        while (remainingDistance > 0) {
            // 用连续的小步滚动模拟真实滚轮，而不是一次性跳转，尽量触发页面自己的滚动监听与加载逻辑。
            const stepDistance = Math.min(CONFIG.wheelLikeScrollStep, remainingDistance) * direction;
            window.scrollBy({ top: stepDistance, behavior: 'auto' });
            remainingDistance -= Math.abs(stepDistance);
            if (remainingDistance > 0) {
                await sleep(CONFIG.wheelLikeScrollDelay);
            }
        }
    }

    function performPrimarySearchScroll() {
        const scrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        window.scrollTo({ top: scrollHeight, behavior: 'auto' });
        window.scrollBy({ top: CONFIG.stuckScrollStep, behavior: 'auto' });
    }

    function getScrollTop() {
        return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    function getDynamicCards() {
        return Array.from(document.querySelectorAll('.bili-dyn-item'));
    }

    function ensureDynamicCardTimeButtons() {
        getDynamicCards().forEach((dynamicCard) => {
            ensureDynamicCardTimeButton(dynamicCard);
        });
    }

    function ensureDynamicCardTimeButton(dynamicCard) {
        if (!dynamicCard || dynamicCard.querySelector('.bdt-card-time-pass-btn')) {
            return;
        }

        const timeElement = getDynamicCardTimeElement(dynamicCard);
        if (!timeElement) {
            return;
        }

        const dateInfo = extractDateInfo(dynamicCard);
        if (!dateInfo) {
            return;
        }

        const passButton = document.createElement('button');
        passButton.className = 'bdt-card-time-pass-btn';
        passButton.type = 'button';
        passButton.textContent = '⏱';
        passButton.title = '记录该动态的时间';
        passButton.setAttribute('aria-label', '记录该动态的时间');
        passButton.addEventListener('click', (event) => {
            // 时间元素附近通常带着原站链接或卡片点击行为，这里拦住默认事件，避免用户只是想回填时间却被带走。
            event.preventDefault();
            event.stopPropagation();
            applyDynamicCardTimeToPanel(dynamicCard);
        });
        timeElement.insertAdjacentElement('afterend', passButton);
    }

    function getDynamicCardTimeElement(dynamicCard) {
        return dynamicCard.querySelector('.bili-dyn-time')
            || dynamicCard.querySelector('[class*="time"][title]')
            || dynamicCard.querySelector('[class*="time"]');
    }

    function applyDynamicCardTimeToPanel(dynamicCard) {
        const dateInfo = extractDateInfo(dynamicCard);
        if (!dateInfo) {
            showToast('这条动态的时间暂时无法识别。', 'error');
            return;
        }

        const startParts = {
            year: dateInfo.year,
            month: dateInfo.month,
            day: dateInfo.day,
            hour: dateInfo.hour,
            minute: dateInfo.minute,
            second: dateInfo.second
        };
        const endDate = new Date(
            dateInfo.year,
            dateInfo.month - 1,
            dateInfo.day,
            dateInfo.hour,
            dateInfo.minute + 1,
            dateInfo.second
        );
        const endParts = {
            year: endDate.getFullYear(),
            month: endDate.getMonth() + 1,
            day: endDate.getDate(),
            hour: endDate.getHours(),
            minute: endDate.getMinutes(),
            second: endDate.getSeconds()
        };

        // 开始时间直接使用当前动态时间，结束时间则自动顺延 1 分钟。
        // 这里交给 Date 处理进位，这样在 23:59:xx 之类的边界场景下也能自然跨小时、跨天。
        setDateTimeGroupParts('start', startParts);
        setDateTimeGroupParts('end', endParts);
        closeDateTimeDropdown();
        updateFiltersFromUi();
        saveFilters();

        const panel = document.getElementById('bdt-panel');
        if (panel) {
            panel.hidden = false;
        }

        showToast(`已记录动态时间: ${formatDateInfoDisplay(startParts)}`, 'success');
    }

    function analyzeDynamicCards(dynamicCards, range) {
        const matches = [];
        let oldestDate = null;
        let oldestCard = null;

        dynamicCards.forEach((card) => {
            const dateInfo = extractDateInfo(card);
            if (!dateInfo) {
                return;
            }
            if (!oldestDate || dateInfo.timestamp < oldestDate.timestamp) {
                oldestDate = dateInfo;
                oldestCard = card;
            }
            if (isDateInfoInRange(dateInfo, range)) {
                matches.push({ card, dateInfo });
            }
        });

        return {
            matches,
            oldestDate,
            oldestCard,
            reachedStartBoundary: Boolean(oldestDate && range.startMs && oldestDate.timestamp * 1000 < range.startMs)
        };
    }

    function isDateInfoInRange(dateInfo, range) {
        const timestampMs = dateInfo.timestamp * 1000;
        if (range.startMs && timestampMs < range.startMs) {
            return false;
        }
        if (range.endMs && timestampMs > range.endMs) {
            return false;
        }
        return true;
    }

    function extractDateInfo(dynamicCard) {
        try {
            const timeElement = dynamicCard.querySelector('.bili-dyn-time') || dynamicCard.querySelector('[class*="time"]');
            if (!timeElement) {
                return null;
            }
            // 优先读取元素属性中的完整时间，其次再回退到页面上展示的相对时间文本。
            const candidateTexts = [
                timeElement.getAttribute('title'),
                timeElement.getAttribute('datetime'),
                timeElement.querySelector('[title]')?.getAttribute('title'),
                timeElement.querySelector('time')?.getAttribute('datetime'),
                (timeElement.textContent || '').trim()
            ];
            for (const candidateText of candidateTexts) {
                const parsed = parseTimeText(candidateText);
                if (parsed) {
                    return parsed;
                }
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    function parseTimeText(timeText) {
        if (!timeText) {
            return null;
        }

        const now = new Date();
        const normalizedText = String(timeText).replace(/\s+/g, ' ').trim();
        // 统一把 Date 对象转成脚本内部使用的日期结构，避免每个分支重复拆字段。
        const buildDateInfoFromDate = (date) => buildDateInfo(
            date.getFullYear(),
            date.getMonth() + 1,
            date.getDate(),
            date.getHours(),
            date.getMinutes(),
            date.getSeconds()
        );
        let match = normalizedText.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (match) {
            return buildDateInfo(
                parseInt(match[1], 10),
                parseInt(match[2], 10),
                parseInt(match[3], 10),
                parseInt(match[4] || '0', 10),
                parseInt(match[5] || '0', 10),
                parseInt(match[6] || '0', 10)
            );
        }

        match = normalizedText.match(/(\d{1,2})[\/\-月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (match) {
            const month = parseInt(match[1], 10);
            const day = parseInt(match[2], 10);
            let year = now.getFullYear();
            if (month > now.getMonth() + 1) {
                year -= 1;
            }
            return buildDateInfo(
                year,
                month,
                day,
                parseInt(match[3] || '0', 10),
                parseInt(match[4] || '0', 10),
                parseInt(match[5] || '0', 10)
            );
        }

        // “刚刚”通常表示极近时间，这里直接按当前时刻处理，避免最新动态被漏掉。
        if (normalizedText === '刚刚') {
            return buildDateInfoFromDate(now);
        }

        // B 站有时会把极近时间显示成“X秒前”，这类动态若没有 title/datetime 属性，就只能靠文本兜底。
        match = normalizedText.match(/(\d+)秒前/);
        if (match) {
            const date = new Date(now.getTime() - parseInt(match[1], 10) * 1000);
            return buildDateInfoFromDate(date);
        }

        match = normalizedText.match(/(\d+)分钟前/);
        if (match) {
            const date = new Date(now.getTime() - parseInt(match[1], 10) * 60000);
            return buildDateInfoFromDate(date);
        }

        match = normalizedText.match(/(\d+)小时前/);
        if (match) {
            const date = new Date(now.getTime() - parseInt(match[1], 10) * 3600000);
            return buildDateInfoFromDate(date);
        }

        // “今天 HH:mm[:ss]”在没有年份和月日信息时，也要按今天的自然日来补齐。
        match = normalizedText.match(/今天(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (match) {
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(match[1] || '0', 10), parseInt(match[2] || '0', 10), parseInt(match[3] || '0', 10));
            return buildDateInfoFromDate(date);
        }

        match = normalizedText.match(/昨天(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (match) {
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, parseInt(match[1] || '0', 10), parseInt(match[2] || '0', 10), parseInt(match[3] || '0', 10));
            return buildDateInfoFromDate(date);
        }

        match = normalizedText.match(/前天(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (match) {
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, parseInt(match[1] || '0', 10), parseInt(match[2] || '0', 10), parseInt(match[3] || '0', 10));
            return buildDateInfoFromDate(date);
        }

        // “X天前”优先按自然日回推；若文本里附带了时分秒，就用该天的明确时刻，否则退回到“当前时刻减去 N 天”。
        match = normalizedText.match(/(\d+)天前(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (match) {
            const dayOffset = parseInt(match[1], 10);
            if (match[2] !== undefined) {
                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset, parseInt(match[2] || '0', 10), parseInt(match[3] || '0', 10), parseInt(match[4] || '0', 10));
                return buildDateInfoFromDate(date);
            }
            const date = new Date(now.getTime() - dayOffset * 86400000);
            return buildDateInfoFromDate(date);
        }

        return null;
    }

    function clearHighlightedDynamics() {
        document.querySelectorAll('.bdt-time-match').forEach((card) => {
            card.classList.remove('bdt-time-match');
            card.style.outline = '';
            card.style.outlineOffset = '';
            card.style.boxShadow = '';
            card.style.position = '';
        });
        document.querySelectorAll('.bdt-time-badge').forEach((badge) => badge.remove());
    }

    function highlightMatchedDynamics(matches) {
        clearHighlightedDynamics();

        matches.forEach(({ card }, index) => {
            card.classList.add('bdt-time-match');
            card.style.outline = '3px solid #667eea';
            card.style.outlineOffset = '2px';
            card.style.boxShadow = '0 0 0 6px rgba(102, 126, 234, 0.12)';
            card.style.position = 'relative';

            if (index === 0) {
                const badge = document.createElement('div');
                badge.className = 'bdt-time-badge';
                badge.textContent = `找到 ${matches.length} 条`;
                badge.style.cssText = `
                    position: absolute;
                    top: -14px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #fff;
                    padding: 6px 14px;
                    border-radius: 999px;
                    font-size: 12px;
                    font-weight: 700;
                    z-index: 2;
                    box-shadow: 0 6px 16px rgba(102, 126, 234, 0.35);
                    pointer-events: none;
                `;
                card.appendChild(badge);
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    function buildDateRangeFromFilters(filters) {
        const hasStart = Boolean(filters.rangeStart);
        const hasEnd = Boolean(filters.rangeEnd);

        if (!hasStart && !hasEnd) {
            showToast('请先填写开始时间或结束时间。', 'error');
            return null;
        }

        const startValue = hasStart ? parseStoredDateTimeValue(filters.rangeStart, 'start') : null;
        const endValue = hasEnd ? parseStoredDateTimeValue(filters.rangeEnd, 'end') : null;
        const startMs = startValue ? buildDateMsFromParts(startValue) : 0;
        const endMs = endValue ? buildDateMsFromParts(endValue) : null;

        if (hasStart && (!startValue || Number.isNaN(startMs))) {
            showToast('开始时间格式无效。', 'error');
            return null;
        }
        if (hasEnd && (!endValue || endMs === null || Number.isNaN(endMs))) {
            showToast('结束时间格式无效。', 'error');
            return null;
        }
        if (endMs !== null && startMs > endMs) {
            showToast('开始时间不能晚于结束时间。', 'error');
            return null;
        }

        return {
            startMs,
            endMs
        };
    }

    function isDynamicSearchPage() {
        return location.hostname === 't.bilibili.com'
            || (location.hostname === 'space.bilibili.com' && /\/dynamic/.test(location.pathname));
    }

    function ensureToastWrap() {
        let wrap = document.getElementById('bdt-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'bdt-toast-wrap';
            document.body.appendChild(wrap);
        }
        return wrap;
    }

    function showToast(message, type = 'info') {
        const wrap = ensureToastWrap();
        const toast = document.createElement('div');
        toast.className = `bdt-toast ${type === 'success' ? 'bdt-toast-success' : ''} ${type === 'error' ? 'bdt-toast-error' : ''}`.trim();
        toast.textContent = message;
        wrap.appendChild(toast);
        window.setTimeout(() => toast.remove(), 2600);
    }

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function createDateTimeGroupMarkup(prefix, title) {
        const transferIcon = prefix === 'end' ? '↓' : '↑';
        const transferTargetText = prefix === 'end' ? '开始' : '结束';
        return `
            <div class="bdt-time-group">
                <div class="bdt-time-group-head">
                    <div class="bdt-time-group-title">${title}</div>
                    <div class="bdt-time-group-actions">
                        <button
                            class="bdt-time-group-icon-btn"
                            id="bdt-${prefix}-transfer-btn"
                            type="button"
                            aria-label="将${title}时间传递给${transferTargetText}"
                            title="将${title}时间传递给${transferTargetText}"
                        ><span class="bdt-time-group-transfer-icon">${transferIcon}</span></button>
                        <button
                            class="bdt-time-group-icon-btn"
                            id="bdt-${prefix}-reset-btn"
                            type="button"
                            aria-label="重置${title}时间"
                            title="重置${title}时间"
                        >↺</button>
                    </div>
                </div>
                <div class="bdt-time-row">
                    <button class="bdt-date-picker-btn" id="bdt-${prefix}-date-picker-btn" type="button" aria-label="选择日期" title="选择日期">📅</button>
                    <input class="bdt-date-picker-proxy" id="bdt-${prefix}-date-picker-proxy" type="date" tabindex="-1" aria-hidden="true">
                    ${createDateTimeFieldMarkup(prefix, 'year', '年', 4, true, 'bdt-time-field-year')}
                    ${createDateTimeFieldMarkup(prefix, 'month', '月', 2, true)}
                    ${createDateTimeFieldMarkup(prefix, 'day', '日', 2, true)}
                    <span class="bdt-date-time-gap" aria-hidden="true"></span>
                    ${createDateTimeFieldMarkup(prefix, 'hour', '', 2, true)}
                    <span class="bdt-time-separator">:</span>
                    ${createDateTimeFieldMarkup(prefix, 'minute', '', 2, true)}
                    <span class="bdt-time-separator">:</span>
                    ${createDateTimeFieldMarkup(prefix, 'second', '', 2, true)}
                </div>
            </div>
        `;
    }

    function createDateTimeFieldMarkup(prefix, part, unitText, maxLength, hasDropdown, extraClass = '') {
        const classNames = ['bdt-time-field'];
        if (extraClass) {
            classNames.push(extraClass);
        }
        if (hasDropdown) {
            classNames.push('bdt-time-field-dropdownable');
        }
        return `
            <label class="${classNames.join(' ')}">
                <input
                    class="bdt-input"
                    id="bdt-${prefix}-${part}"
                    type="text"
                    inputmode="numeric"
                    autocomplete="off"
                    maxlength="${maxLength}"
                    data-time-part="${part}"
                    data-has-dropdown="${hasDropdown ? 'true' : 'false'}"
                >
                ${unitText ? `<span class="bdt-time-unit">${unitText}</span>` : ''}
            </label>
        `;
    }

    function createSequentialNumberOptions(start, end) {
        const values = [];
        for (let value = start; value <= end; value += 1) {
            values.push(String(value));
        }
        return values;
    }

    function bindDateTimeGroupEvents(prefix) {
        const inputPartNames = ['year', 'month', 'day', 'hour', 'minute', 'second'];
        inputPartNames.forEach((partName) => {
            const input = document.getElementById(`bdt-${prefix}-${partName}`);
            if (!input) {
                return;
            }
            input.addEventListener('input', () => {
                // 仅保留数字，让手动输入和自定义建议菜单共用同一套清洗逻辑。
                input.value = sanitizeNumericInput(input.value, partName === 'year' ? 4 : 2);
                updateDurationDisplay();
                if (shouldUseDateTimeDropdown(input)) {
                    renderDateTimeDropdown(input, partName, true);
                }
            });
            input.addEventListener('focus', () => {
                if (shouldUseDateTimeDropdown(input)) {
                    renderDateTimeDropdown(input, partName, false);
                }
            });
            input.addEventListener('click', () => {
                if (shouldUseDateTimeDropdown(input)) {
                    renderDateTimeDropdown(input, partName, false);
                }
            });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    closeDateTimeDropdown();
                    return;
                }
                if (event.key === 'ArrowDown' && shouldUseDateTimeDropdown(input)) {
                    event.preventDefault();
                    renderDateTimeDropdown(input, partName, false);
                }
            });
            input.addEventListener('blur', () => {
                window.setTimeout(() => {
                    closeDateTimeDropdownIfDetached(input);
                }, 0);
                normalizeDateTimeGroupInput(prefix);
                updateFiltersFromUi();
                saveFilters();
            });
        });

        const resetButton = document.getElementById(`bdt-${prefix}-reset-btn`);
        if (resetButton) {
            resetButton.addEventListener('click', () => {
                // 重置后立即同步 UI、时长显示和持久化设置，保证按钮行为和手动编辑一致。
                resetDateTimeGroup(prefix);
            });
        }

        const transferButton = document.getElementById(`bdt-${prefix}-transfer-btn`);
        if (transferButton) {
            transferButton.addEventListener('click', () => {
                transferDateTimeGroupValue(prefix);
            });
        }

        const pickerButton = document.getElementById(`bdt-${prefix}-date-picker-btn`);
        const pickerProxy = document.getElementById(`bdt-${prefix}-date-picker-proxy`);
        if (pickerButton && pickerProxy) {
            pickerButton.addEventListener('click', () => {
                const currentValue = readDateTimeGroupParts(prefix);
                if (currentValue) {
                    pickerProxy.value = `${padNumber(currentValue.year, 4)}-${padNumber(currentValue.month)}-${padNumber(currentValue.day)}`;
                }
                if (typeof pickerProxy.showPicker === 'function') {
                    pickerProxy.showPicker();
                } else {
                    // 某些环境不支持 showPicker 时，退回到原生 click 行为。
                    pickerProxy.click();
                }
            });
            pickerProxy.addEventListener('change', () => {
                syncDatePickerValueToInputs(prefix, pickerProxy.value);
                updateFiltersFromUi();
                saveFilters();
            });
        }
    }

    function resetDateTimeGroup(prefix) {
        // “开始”恢复到当天起始时刻，“结束”恢复到当前时刻，和默认筛选值保持完全一致。
        const defaultParts = prefix === 'start' ? getStartOfTodayDateTimeParts() : getNowDateTimeParts();
        setDateTimeGroupParts(prefix, defaultParts);
        closeDateTimeDropdown();
        updateFiltersFromUi();
        saveFilters();
    }

    function transferDateTimeGroupValue(sourcePrefix) {
        const sourceParts = getCurrentValidatedDateTimeGroupParts(sourcePrefix);
        if (!sourceParts) {
            showToast('当前时间格式无效，无法传递。', 'error');
            return;
        }
        const targetPrefix = sourcePrefix === 'end' ? 'start' : 'end';
        // 使用当前已校验的时间整体覆盖对方，保证两个时间组之间的传递结果完全一致。
        setDateTimeGroupParts(targetPrefix, {
            year: sourceParts.year,
            month: sourceParts.month,
            day: sourceParts.day,
            hour: sourceParts.hour,
            minute: sourceParts.minute,
            second: sourceParts.second
        });
        closeDateTimeDropdown();
        updateFiltersFromUi();
        saveFilters();
    }

    function syncDateTimeGroupFromValue(prefix, value) {
        const parsedValue = parseStoredDateTimeValue(value, prefix);
        const fallbackValue = prefix === 'start' ? getStartOfTodayDateTimeParts() : getNowDateTimeParts();
        setDateTimeGroupParts(prefix, parsedValue || fallbackValue);
    }

    function setDateTimeGroupParts(prefix, parts) {
        setInputValue(`bdt-${prefix}-year`, formatDateTimeInputDisplayValue(parts.year, 'year'));
        setInputValue(`bdt-${prefix}-month`, formatDateTimeInputDisplayValue(parts.month, 'month'));
        setInputValue(`bdt-${prefix}-day`, formatDateTimeInputDisplayValue(parts.day, 'day'));
        setInputValue(`bdt-${prefix}-hour`, formatDateTimeInputDisplayValue(parts.hour, 'hour'));
        setInputValue(`bdt-${prefix}-minute`, formatDateTimeInputDisplayValue(parts.minute, 'minute'));
        setInputValue(`bdt-${prefix}-second`, formatDateTimeInputDisplayValue(parts.second, 'second'));
        const pickerProxy = document.getElementById(`bdt-${prefix}-date-picker-proxy`);
        if (pickerProxy) {
            pickerProxy.value = `${padNumber(parts.year, 4)}-${padNumber(parts.month)}-${padNumber(parts.day)}`;
        }
    }

    function setInputValue(elementId, value) {
        const input = document.getElementById(elementId);
        if (input) {
            input.value = value;
        }
    }

    function readDateTimeGroupValue(prefix) {
        const parts = readDateTimeGroupParts(prefix);
        return parts ? formatDateTimeValue(parts) : '';
    }

    function readDateTimeGroupParts(prefix) {
        const yearText = getInputNumericValue(`bdt-${prefix}-year`);
        const monthText = getInputNumericValue(`bdt-${prefix}-month`);
        const dayText = getInputNumericValue(`bdt-${prefix}-day`);
        const hourText = getInputNumericValue(`bdt-${prefix}-hour`);
        const minuteText = getInputNumericValue(`bdt-${prefix}-minute`);
        const secondText = getInputNumericValue(`bdt-${prefix}-second`);
        const allEmpty = [yearText, monthText, dayText, hourText, minuteText, secondText].every((value) => !value);
        if (allEmpty) {
            return null;
        }
        return {
            year: yearText ? parseInt(yearText, 10) : NaN,
            month: monthText ? parseInt(monthText, 10) : NaN,
            day: dayText ? parseInt(dayText, 10) : NaN,
            hour: hourText ? parseInt(hourText, 10) : NaN,
            minute: minuteText ? parseInt(minuteText, 10) : NaN,
            second: secondText ? parseInt(secondText, 10) : NaN
        };
    }

    function getInputNumericValue(elementId) {
        return (document.getElementById(elementId)?.value || '').trim();
    }

    function updateDurationDisplay() {
        const durationWrap = document.getElementById('bdt-duration');
        const durationValue = document.getElementById('bdt-duration-value');
        if (!durationWrap || !durationValue) {
            return;
        }

        const startParts = getCurrentValidatedDateTimeGroupParts('start');
        const endParts = getCurrentValidatedDateTimeGroupParts('end');
        if (!startParts || !endParts) {
            durationWrap.classList.remove('bdt-duration-error');
            durationValue.textContent = '--';
            return;
        }

        const startMs = buildDateMsFromParts(startParts);
        const endMs = buildDateMsFromParts(endParts);
        const durationMs = endMs - startMs;
        durationWrap.classList.toggle('bdt-duration-error', durationMs < 0);
        durationValue.textContent = formatCalendarDurationBetweenParts(startParts, endParts);
    }

    function getCurrentValidatedDateTimeGroupParts(prefix) {
        const parts = readDateTimeGroupParts(prefix);
        if (!parts) {
            return null;
        }
        if (!isValidDateTimeParts(parts)) {
            return null;
        }
        return parts;
    }

    function isValidDateTimeParts(parts) {
        const values = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
        if (values.some((value) => !Number.isFinite(value))) {
            return false;
        }
        if (parts.year < 0 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59 || parts.second < 0 || parts.second > 59) {
            return false;
        }
        const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        return date.getFullYear() === parts.year
            && date.getMonth() === parts.month - 1
            && date.getDate() === parts.day
            && date.getHours() === parts.hour
            && date.getMinutes() === parts.minute
            && date.getSeconds() === parts.second;
    }

    function formatCalendarDurationBetweenParts(startParts, endParts) {
        const startMs = buildDateMsFromParts(startParts);
        const endMs = buildDateMsFromParts(endParts);
        const isNegative = endMs < startMs;
        const earlierParts = isNegative ? endParts : startParts;
        const laterParts = isNegative ? startParts : endParts;
        const durationParts = calculateCalendarDurationParts(earlierParts, laterParts);
        return `${isNegative ? '-' : ''}${formatCalendarDurationParts(durationParts)}`;
    }

    function calculateCalendarDurationParts(startParts, endParts) {
        const borrowedEnd = {
            year: endParts.year,
            month: endParts.month,
            day: endParts.day,
            hour: endParts.hour,
            minute: endParts.minute,
            second: endParts.second
        };

        if (borrowedEnd.second < startParts.second) {
            borrowedEnd.minute -= 1;
            borrowedEnd.second += 60;
        }
        if (borrowedEnd.minute < startParts.minute) {
            borrowedEnd.hour -= 1;
            borrowedEnd.minute += 60;
        }
        if (borrowedEnd.hour < startParts.hour) {
            borrowedEnd.day -= 1;
            borrowedEnd.hour += 24;
        }
        if (borrowedEnd.day < startParts.day) {
            borrowedEnd.month -= 1;
            if (borrowedEnd.month < 1) {
                borrowedEnd.month = 12;
                borrowedEnd.year -= 1;
            }
            borrowedEnd.day += getDaysInMonth(borrowedEnd.year, borrowedEnd.month);
        }
        if (borrowedEnd.month < startParts.month) {
            borrowedEnd.year -= 1;
            borrowedEnd.month += 12;
        }

        return {
            years: borrowedEnd.year - startParts.year,
            months: borrowedEnd.month - startParts.month,
            days: borrowedEnd.day - startParts.day,
            hours: borrowedEnd.hour - startParts.hour,
            minutes: borrowedEnd.minute - startParts.minute,
            seconds: borrowedEnd.second - startParts.second
        };
    }

    function formatCalendarDurationParts(durationParts) {
        let prefix = '';
        if (durationParts.years > 0) {
            prefix = `${durationParts.years}年${durationParts.months}月${durationParts.days}日`;
        } else if (durationParts.months > 0) {
            prefix = `${durationParts.months}月${durationParts.days}日`;
        } else if (durationParts.days > 0) {
            prefix = `${durationParts.days}日`;
        }

        const timeText = `${durationParts.hours}:${durationParts.minutes}:${durationParts.seconds}`;
        return `${prefix}${prefix ? ' ' : ''}${timeText}`;
    }

    function getDaysInMonth(year, month) {
        return new Date(year, month, 0).getDate();
    }

    function normalizeDateTimeGroupInput(prefix) {
        const parts = readDateTimeGroupParts(prefix);
        if (!parts) {
            return;
        }

        const normalizedParts = {
            year: normalizeNumberPart(parts.year, 0, 9999),
            month: normalizeNumberPart(parts.month, 1, 12),
            day: normalizeNumberPart(parts.day, 1, 31),
            hour: normalizeNumberPart(parts.hour, 0, 23),
            minute: normalizeNumberPart(parts.minute, 0, 59),
            second: normalizeNumberPart(parts.second, 0, 59)
        };
        normalizedParts.day = clampDayToMonth(normalizedParts.year, normalizedParts.month, normalizedParts.day);
        setDateTimeGroupParts(prefix, normalizedParts);
    }

    function normalizeNumberPart(value, min, max) {
        if (!Number.isFinite(value)) {
            return min;
        }
        return Math.min(max, Math.max(min, value));
    }

    function clampDayToMonth(year, month, day) {
        const safeYear = Number.isFinite(year) ? year : new Date().getFullYear();
        const safeMonth = Number.isFinite(month) ? month : 1;
        const maxDay = new Date(safeYear, safeMonth, 0).getDate();
        return Math.min(maxDay, Math.max(1, Number.isFinite(day) ? day : 1));
    }

    function syncDatePickerValueToInputs(prefix, dateValue) {
        const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            return;
        }
        const currentParts = readDateTimeGroupParts(prefix) || (prefix === 'start' ? getStartOfTodayDateTimeParts() : getNowDateTimeParts());
        setDateTimeGroupParts(prefix, {
            year: parseInt(match[1], 10),
            month: parseInt(match[2], 10),
            day: parseInt(match[3], 10),
            hour: currentParts.hour,
            minute: currentParts.minute,
            second: currentParts.second
        });
    }

    function sanitizeNumericInput(value, maxLength) {
        return String(value || '').replace(/\D+/g, '').slice(0, maxLength);
    }

    function formatDateTimeInputDisplayValue(value, partName) {
        if (!Number.isFinite(value)) {
            return '';
        }
        if (partName === 'year') {
            return String(value);
        }
        return String(Number(value));
    }

    function shouldUseDateTimeDropdown(input) {
        return input?.dataset?.hasDropdown === 'true';
    }

    function bindGlobalDateTimeDropdownEvents() {
        if (state.dropdownEventsBound) {
            return;
        }

        // 点击悬浮层和输入框之外的区域时，收起当前时间建议菜单。
        document.addEventListener('mousedown', (event) => {
            const dropdown = document.getElementById('bdt-time-dropdown');
            const target = event.target;
            if (dropdown?.contains(target) || target?.closest?.('.bdt-time-field')) {
                return;
            }
            closeDateTimeDropdown();
        }, true);

        window.addEventListener('resize', () => {
            closeDateTimeDropdown();
            const launcher = document.getElementById('bdt-launcher');
            clampFloatingElementToViewport(launcher);
            if (launcher?.dataset.positionPinned === 'true') {
                // 视口尺寸变化后如果按钮被挤回可视区，立即同步持久化坐标，避免下次刷新又跑回旧位置。
                persistLauncherPositionFromElement(launcher);
            }
            syncPanelPositionToLauncher(true);
        });

        state.dropdownEventsBound = true;
    }

    function ensureDateTimeDropdown() {
        let dropdown = document.getElementById('bdt-time-dropdown');
        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.id = 'bdt-time-dropdown';
            dropdown.className = 'bdt-time-dropdown';
            dropdown.hidden = true;
            dropdown.addEventListener('wheel', (event) => {
                const maxScrollTop = dropdown.scrollHeight - dropdown.clientHeight;
                // 统一手动驱动下拉栏滚动，避免默认滚动被拦截后菜单自身也滚不动。
                event.preventDefault();
                if (maxScrollTop <= 0) {
                    return;
                }
                const nextScrollTop = dropdown.scrollTop + event.deltaY;
                dropdown.scrollTop = Math.min(maxScrollTop, Math.max(0, nextScrollTop));
            }, { passive: false });
            document.body.appendChild(dropdown);
        }
        return dropdown;
    }

    function renderDateTimeDropdown(input, partName, shouldFilterByInput = true) {
        const dropdown = ensureDateTimeDropdown();
        const options = getDateTimeDropdownOptions(partName, input.value, shouldFilterByInput);
        if (!options.length) {
            closeDateTimeDropdown();
            return;
        }
        const currentOptionValue = normalizeDropdownComparableValue(input.value, partName);

        dropdown.innerHTML = options
            .map((optionValue) => {
                const activeClass = optionValue === currentOptionValue ? ' is-active' : '';
                return `<button class="bdt-time-dropdown-option${activeClass}" type="button" data-value="${optionValue}">${optionValue}</button>`;
            })
            .join('');

        dropdown.querySelectorAll('.bdt-time-dropdown-option').forEach((optionButton) => {
            optionButton.addEventListener('mousedown', (event) => {
                event.preventDefault();
            });
            optionButton.addEventListener('click', () => {
                // 选择建议值后直接回填输入框，再走现有的归一化与持久化逻辑。
                input.value = optionButton.dataset.value || '';
                input.dispatchEvent(new Event('blur'));
                closeDateTimeDropdown();
            });
        });

        const rect = input.getBoundingClientRect();
        dropdown.style.left = `${Math.max(8, rect.left)}px`;
        dropdown.style.top = `${rect.bottom + 6}px`;
        dropdown.style.width = `${Math.ceil(rect.width)}px`;
        dropdown.style.minWidth = `${Math.ceil(rect.width)}px`;
        dropdown.style.maxWidth = `${Math.ceil(rect.width)}px`;
        dropdown.hidden = false;

        const activeOption = dropdown.querySelector('.bdt-time-dropdown-option.is-active');
        if (activeOption) {
            const desiredScrollTop = activeOption.offsetTop - ((dropdown.clientHeight - activeOption.offsetHeight) / 2);
            const maxScrollTop = Math.max(0, dropdown.scrollHeight - dropdown.clientHeight);
            dropdown.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop));
        }

        state.activeDateTimeDropdown = {
            inputId: input.id
        };
    }

    function getDateTimeDropdownOptions(partName, currentValue, shouldFilterByInput = true) {
        let options = [];
        if (partName === 'year') {
            const normalizedCurrentValue = normalizeDropdownComparableValue(currentValue, partName);
            const actualCurrentYear = new Date().getFullYear();
            const baseYear = normalizedCurrentValue
                ? Math.min(actualCurrentYear, Math.max(0, Number(normalizedCurrentValue)))
                : actualCurrentYear;
            const startYear = Math.max(0, baseYear - 10);
            const endYear = Math.min(actualCurrentYear, baseYear + 10);
            for (let year = startYear; year <= endYear; year += 1) {
                options.push(String(year));
            }
        } else if (partName === 'month') {
            options = createSequentialNumberOptions(1, 12);
        } else if (partName === 'day') {
            options = createSequentialNumberOptions(1, 31);
        } else if (partName === 'hour') {
            options = createSequentialNumberOptions(0, 23);
        } else if (partName === 'minute') {
            options = createSequentialNumberOptions(0, 59);
        } else if (partName === 'second') {
            options = createSequentialNumberOptions(0, 59);
        }

        if (!shouldFilterByInput) {
            return options;
        }

        const normalizedCurrentValue = normalizeDropdownComparableValue(currentValue, partName);
        if (!normalizedCurrentValue) {
            return options;
        }
        return options.filter((optionValue) => optionValue.startsWith(normalizedCurrentValue));
    }

    function normalizeDropdownComparableValue(value, partName) {
        const sanitizedValue = sanitizeNumericInput(value, partName === 'year' ? 4 : 2);
        if (!sanitizedValue) {
            return '';
        }
        if (partName === 'year') {
            return sanitizedValue;
        }
        return String(Number(sanitizedValue));
    }

    function closeDateTimeDropdownIfDetached(input) {
        if (!state.activeDateTimeDropdown || state.activeDateTimeDropdown.inputId !== input.id) {
            return;
        }
        const activeElement = document.activeElement;
        if (activeElement?.closest?.('#bdt-time-dropdown')) {
            return;
        }
        closeDateTimeDropdown();
    }

    function closeDateTimeDropdown() {
        const dropdown = document.getElementById('bdt-time-dropdown');
        if (dropdown) {
            dropdown.hidden = true;
            dropdown.innerHTML = '';
        }
        state.activeDateTimeDropdown = null;
    }

    function normalizeFilterValue(value, fieldType, fallbackValue) {
        const parsedValue = parseStoredDateTimeValue(value, fieldType);
        return parsedValue ? formatDateTimeValue(parsedValue) : fallbackValue;
    }

    function formatDateTimeValue(parts) {
        return `${padNumber(parts.year, 4)}-${padNumber(parts.month)}-${padNumber(parts.day)} ${padNumber(parts.hour)}:${padNumber(parts.minute)}:${padNumber(parts.second)}`;
    }

    function parseStoredDateTimeValue(value, fieldType) {
        if (!value) {
            return null;
        }

        const normalizedValue = String(value).trim();
        let match = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (match) {
            return {
                year: parseInt(match[1], 10),
                month: parseInt(match[2], 10),
                day: parseInt(match[3], 10),
                hour: parseInt(match[4], 10),
                minute: parseInt(match[5], 10),
                second: parseInt(match[6], 10)
            };
        }

        // 兼容旧版仅保存日期的格式，保留原先“按整天”查找的语义。
        match = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) {
            return {
                year: parseInt(match[1], 10),
                month: parseInt(match[2], 10),
                day: parseInt(match[3], 10),
                hour: fieldType === 'end' ? 23 : 0,
                minute: fieldType === 'end' ? 59 : 0,
                second: fieldType === 'end' ? 59 : 0
            };
        }

        return null;
    }

    function buildDateMsFromParts(parts) {
        return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second).getTime();
    }

    function buildDateInfo(year, month, day, hour = 0, minute = 0, second = 0) {
        const date = new Date(year, month - 1, day, hour, minute, second);
        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
            minute: date.getMinutes(),
            second: date.getSeconds(),
            timestamp: date.getTime() / 1000
        };
    }

    function getStartOfTodayDateTimeParts() {
        const now = new Date();
        return {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate(),
            hour: 0,
            minute: 0,
            second: 0
        };
    }

    function getNowDateTimeParts() {
        const now = new Date();
        return {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate(),
            hour: now.getHours(),
            minute: now.getMinutes(),
            second: now.getSeconds()
        };
    }

    function padNumber(value, length = 2) {
        return String(value).padStart(length, '0');
    }
})();
