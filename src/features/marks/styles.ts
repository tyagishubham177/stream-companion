export const buttonStyles = `
:host{all:initial;position:absolute;inset:0;display:block;pointer-events:none;z-index:2;font-family:Arial,sans-serif;color-scheme:dark}
button{position:absolute;top:8px;right:8px;box-sizing:border-box;min-width:32px;height:30px;padding:4px 7px;display:flex;align-items:center;justify-content:center;gap:4px;pointer-events:auto;border:1px solid #62645e;border-radius:6px;background:#151718f2;color:#fff;font:600 12px/18px Arial,sans-serif;cursor:pointer;white-space:nowrap;opacity:0;transition:opacity .1s,background .1s}
:host([data-active=true]) button,:host([data-reveal=true]) button,:host([data-expanded=true]) button,button:focus{opacity:1}
:host([data-expanded=true]) button{transition:none}
:host([data-corner=top-left]) button{right:auto;left:8px}
button:hover{background:#30332d}button:focus-visible{outline:2px solid #ffe0a1;outline-offset:3px}button[hidden]{display:none}svg{width:18px;height:18px;flex:none}
@media(prefers-reduced-motion:reduce){button{transition:none}}
@media(forced-colors:active){button{background:Canvas;color:CanvasText;border-color:CanvasText}}
`;
export const panelStyles = `
:host{all:initial;position:fixed;inset:0;display:block;z-index:2147483100;pointer-events:none;font-family:Arial,sans-serif;color-scheme:dark;color:#f3f2ed}
:host([data-local=true]){position:absolute;inset:0}
:host([data-local=true]) .menu{position:absolute}
*{box-sizing:border-box}button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible{outline:2px solid #ffe0a1;outline-offset:2px}
.menu{position:fixed;pointer-events:auto;width:260px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:#191b19;border:1px solid #62645e;border-radius:9px;padding:14px;box-shadow:0 12px 36px #0008;font-size:14px;line-height:1.4}
h2{margin:0 25px 12px 0;font-size:17px;line-height:1.3;overflow-wrap:anywhere}.label{font-size:11px;color:#b4b8ae;margin:10px 0 5px;letter-spacing:.03em}
.choice{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:8px 7px;text-align:left;background:transparent;color:#f3f2ed;border:0;border-radius:4px;font-size:14px}
.choice:hover{background:#34382f}.choice[aria-checked=true]{background:#2c3029}.choice svg{width:18px;height:18px;flex:none}.choice .selected{margin-left:auto;font-size:15px}
.divider{border:0;border-top:1px solid #383c34;margin:9px 0}.minor{color:#b4b8ae;font-size:12px;min-height:32px}.close{position:absolute;right:9px;top:8px;width:28px;height:28px;border:0;border-radius:4px;background:transparent;color:#c9cbc5;font-size:22px}.close:hover{background:#34382f}
.feedback{margin:10px 0 0;font-size:12px;color:#ffb3a7;overflow-wrap:anywhere}.toast{pointer-events:auto;position:fixed;right:18px;bottom:18px;max-width:calc(100vw - 36px);padding:12px 15px;border:1px solid #62645e;border-radius:8px;background:#191b19;color:#f3f2ed;box-shadow:0 8px 24px #0008;font-size:13px;line-height:1.45;display:flex;align-items:center;gap:16px}.toast button{border:0;background:transparent;color:#efc675;text-decoration:underline;padding:4px;font-size:13px;white-space:nowrap}.toast.error{border-color:#c88d7e}.toast[hidden]{display:none}button:disabled{opacity:.5;cursor:wait}
@media(forced-colors:active){.menu,.toast{background:Canvas;color:CanvasText;border-color:CanvasText}.choice,.close,.toast button{color:CanvasText}.choice[aria-checked=true]{outline:1px solid Highlight}}
`;
