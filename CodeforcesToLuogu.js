// ==UserScript==
// @name         CF转洛谷
// @namespace    https://github.com/easy-to-notice/CodeforcesToLuogu
// @version      1.11
// @description  Codeforces与洛谷题目链接跳转脚本
// @author       dogyunfei & easy-to-notice
// @match        https://codeforces.com/contest/*/problem/*
// @match        https://codeforces.com/problemset/problem/*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=codeforces.com
// @grant        none
// @grant        none
// @license      MIT
// ==/UserScript==

(()=>{
    let str=window.location.href
    let bigBox=document.querySelector("#sidebar");
    let myButton=document.createElement('button');
    myButton.textContent="点击我去洛谷";
    bigBox.appendChild(myButton);

    let problemId=getProblemId(str);
    let problemChar=getProblemChar(str);
    console.log(problemId);
    console.log(problemChar);
    //给按钮添加点击事件
    myButton.addEventListener('click',()=>{
        window.open("https://www.luogu.com.cn/problem/CF"+problemId+problemChar, '_blank');
    })
    let tijie=document.createElement('button');
    tijie.textContent="点击我去查看中文题解";
    bigBox.appendChild(tijie);
    tijie.addEventListener('click',()=>{
        window.open("https://www.luogu.com.cn/problem/solution/CF"+problemId+problemChar, '_blank');
    })
    
})();


function getProblemId(str){
    let pos = str.indexOf("contest/") + "contest/".length;
    let contestNum = "";
    while (str[pos] >= '0' && str[pos] <= '9') {
        contestNum += str[pos];
        pos++;
    }
    return contestNum;
}

function getProblemChar(str) {
    let pos = str.indexOf("problem/") + "problem/".length;
    let problemLetter = str.substr(pos);
    // 移除所有的'/'符号
    problemLetter = problemLetter.replace(/\//g, '');
    return problemLetter;
}
