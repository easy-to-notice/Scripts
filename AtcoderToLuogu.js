// ==UserScript==
// @name         AT转洛谷
// @namespace    https://github.com/easy-to-notice/AtCoderToLuogu
// @version      1.5
// @description  AtCoder跳转洛谷脚本
// @author       easy-to-notice
// @match        https://atcoder.jp/contests/*/tasks/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=atcoder.jp
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
    'use strict';

    // 1. 解析题目ID
    const getProblemId = () => {
        const match = window.location.pathname.match(/\/tasks\/([^\/]+)$/);
        return match ? match[1] : '';
    };
    const problemId = getProblemId();
    if (!problemId) return;

    // 2. 构建洛谷链接
    const luoguProblemUrl = `https://www.luogu.com.cn/problem/AT_${problemId}`;
    const luoguSolutionUrl = `https://www.luogu.com.cn/problem/solution/AT_${problemId}`;

    // 3. 创建和AtCoder原生.btn-default样式一致的按钮
    const createAtcoderBtn = (text, url, px) => {
        const btn = document.createElement('a');
        btn.href = url;
        btn.target = '_blank';
        btn.textContent = text;
        btn.className = 'btn btn-default btn-sm';
        btn.style.marginLeft = px;
        return btn;
    };

    // 4. 定位<span class="h2">元素并插入按钮
    const injectButtons = () => {
        const h2Element = document.querySelector('span.h2');
        if (h2Element) {
            // 创建洛谷题面/题解按钮
            const problemBtn = createAtcoderBtn('洛谷题面', luoguProblemUrl,'0px');
            const solutionBtn = createAtcoderBtn('洛谷题解', luoguSolutionUrl,'5px');

            // 插入到
            h2Element.appendChild(problemBtn);
            h2Element.appendChild(solutionBtn);
            console.log('✅ 按钮已注入到span.h2元素后方');
        } else {
            // 兜底：1秒后重试一次（防止DOM刚生成还没匹配到）
            setTimeout(injectButtons, 1000);
            console.log('🔄 首次未找到.h2元素，1秒后重试');
        }
    };

    // 注入
    injectButtons();

})();
