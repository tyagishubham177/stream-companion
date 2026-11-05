export const overlayStyles = `
:host{all:initial;position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483000;color-scheme:dark;font-family:Inter,Arial,sans-serif;line-height:1.45}
*,*::before,*::after{box-sizing:border-box}
button,a{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}
.badge{position:fixed;display:block;pointer-events:auto;min-height:30px;padding:5px 9px;border:1px solid #646363;border-radius:7px;background:#151718f2;color:#fff;font-size:12px;font-weight:650;line-height:18px;font-variant-numeric:tabular-nums;box-shadow:0 2px 7px #0005;white-space:nowrap;transition:background .12s,border-color .12s}
.badge:hover{background:#272927;border-color:#f2c85d}.badge[data-rated=true]{color:#ffdf85}.badge[hidden],.panel[hidden]{display:none}
button:focus-visible,a:focus-visible{outline:2px solid #ffdb72;outline-offset:3px}
.panel{position:fixed;pointer-events:auto;width:320px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:21px;border:1px solid #5a5a54;border-radius:12px;background:#171918;color:#f8f8f3;box-shadow:0 16px 50px #0008;font-size:13px;animation:enter .12s ease-out}
.eyebrow{margin:0 32px 12px 0;color:#c9bc97;font-size:10px;letter-spacing:.12em;text-transform:uppercase;font-weight:700}
h2{margin:0 18px 5px 0;font-size:19px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
p{margin:9px 0;color:#c9cbc5}.score{margin:14px 0 3px;font-size:30px;color:#ffdb72;font-weight:650;font-variant-numeric:tabular-nums}.score small{font-size:13px;color:#b8bbb3;font-weight:400}
.meta{font-size:12px;color:#b8bbb3}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:17px;padding-top:15px;border-top:1px solid #343730}.actions button,.actions a{border:1px solid #54584e;border-radius:6px;background:transparent;color:#f8f8f3;padding:7px 10px;text-decoration:none;text-align:center;line-height:18px}.actions button:hover,.actions a:hover{background:#32362e}.actions .primary{background:#edcf83;border-color:#edcf83;color:#191b17;font-weight:650}.actions .primary:hover{background:#ffe5a0}
.close{position:absolute;right:11px;top:9px;width:30px;height:30px;border:0;border-radius:5px;background:transparent;color:#c9cbc5;font-size:22px}.close:hover{background:#343730;color:#fff}.feedback{margin-top:11px;font-size:12px;color:#ffdb72;overflow-wrap:anywhere}
@keyframes enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media(forced-colors:active){.badge,.panel{border:1px solid CanvasText;background:Canvas;color:CanvasText}.badge[data-rated=true],.score,.feedback{color:CanvasText}.actions .primary{background:ButtonFace;color:ButtonText;border:1px solid ButtonText}}
`;
