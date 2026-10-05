// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  ExtensionHost,
  MATH_EXTENSION_ID,
  MERMAID_EXTENSION_ID,
  MarkdownDocumentSession,
  createSessionEditorView,
  isMathMarker,
  isMermaidMarker,
  notifyCapabilitiesChanged,
  type EditorExtension,
  type SessionEditorViewHandle
} from '../src/index.js';

/**
 * 内置插件启停落到编辑器上。
 *
 * 宿主那边（`extension-host.test.ts`）证明的是「谓词一改，查表立刻变」。这一层证明的是
 * **已经渲染出来的东西会跟着变** —— 两件事，缺一个用户看到的就是「关了设置没反应」。
 *
 * 这条路有两处会各自静默失效，所以两条都要有：
 *
 * 1. **投影得重算。** 它是 `StateField`，只在列出的那几个变化上重跑，而「用户在设置窗口里
 *    拨了一个开关」不产生其中任何一个。`notifyCapabilitiesChanged` 就是那个信号。
 * 2. **widget 的 DOM 得重建。** 投影重算会造出字段完全相同的新 widget，而
 *    `InlineMathWidget.eq` 比的就是那几个字段 —— 相等时 CodeMirror 会复用旧 DOM 并只调
 *    `updateDOM`，被关掉的扩展于是继续渲染。这条用例真正钉住的是这件事。
 *
 * 反面同样不能省：关掉 math 不能连累 mermaid（同一份文档里两种标记都出现）。
 */
describe('内置插件启停 · 视觉投影', () => {
  /** 一个立刻可用、渲染出一枚可识别标记的假扩展。 */
  function fakeExtension(id: string, marker: (m: { type: string }) => boolean): EditorExtension {
    return {
      id,
      canHandle: (m) => marker(m),
      load: async () => {},
      activate: (_marker, container) => {
        container.innerHTML = `<span class="fake-${id}">rendered</span>`;
        return { update: () => {}, destroy: () => {} };
      }
    };
  }

  function mount(
    source: string,
    isEnabled: (id: string) => boolean
  ): { parent: HTMLDivElement; host: ExtensionHost; handle: SessionEditorViewHandle } {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const host = new ExtensionHost(isEnabled);
    host.registerLazy({
      id: MATH_EXTENSION_ID,
      matches: isMathMarker,
      load: async () => fakeExtension(MATH_EXTENSION_ID, isMathMarker)
    });
    host.registerLazy({
      id: MERMAID_EXTENSION_ID,
      matches: isMermaidMarker,
      load: async () => fakeExtension(MERMAID_EXTENSION_ID, isMermaidMarker)
    });

    const handle = createSessionEditorView({
      parent,
      session: new MarkdownDocumentSession(source),
      surfaceId: 'capability-toggle',
      surfaceKind: 'visual',
      extensionHost: host
    });

    return { parent, host, handle };
  }

  /** 等 `mountExtension` 那条 `load() → activate()` 的微任务链跑完。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const MATH_SOURCE = '$E = mc^2$\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n';

  it('关掉 math：已经渲染出来的公式退回源码，mermaid 照常渲染', async () => {
    let disabled = false;
    const { parent, handle } = mount(MATH_SOURCE, (id) => !(disabled && id === MATH_EXTENSION_ID));

    await settle();
    // 两个扩展都装上了，先钉住这个前提 —— 否则下面的「消失了」可能是从来没出现过
    expect(parent.querySelector(`.fake-${MATH_EXTENSION_ID}`)).not.toBeNull();
    expect(parent.querySelector(`.fake-${MERMAID_EXTENSION_ID}`)).not.toBeNull();

    disabled = true;
    notifyCapabilitiesChanged(handle.view);
    await settle();

    // 公式退回源码：扩展不再渲染
    expect(parent.querySelector(`.fake-${MATH_EXTENSION_ID}`)).toBeNull();
    // 反面一：源码可见（不是变成一片空白）
    expect(parent.textContent).toContain('$E = mc^2$');
    // 反面二：关掉 math 不能连累 mermaid
    expect(parent.querySelector(`.fake-${MERMAID_EXTENSION_ID}`)).not.toBeNull();
  });

  it('关掉 mermaid：图表退回源码，math 照常渲染', async () => {
    let disabled = false;
    const { parent, handle } = mount(
      MATH_SOURCE,
      (id) => !(disabled && id === MERMAID_EXTENSION_ID)
    );

    await settle();
    expect(parent.querySelector(`.fake-${MERMAID_EXTENSION_ID}`)).not.toBeNull();

    disabled = true;
    notifyCapabilitiesChanged(handle.view);
    await settle();

    expect(parent.querySelector(`.fake-${MERMAID_EXTENSION_ID}`)).toBeNull();
    // 源码可见
    expect(parent.textContent).toContain('graph TD;');
    // 反面：关掉 mermaid 不能连累 math
    expect(parent.querySelector(`.fake-${MATH_EXTENSION_ID}`)).not.toBeNull();
  });

  it('再打开：公式回到渲染态，不用重建视图', async () => {
    let disabled = false;
    const { parent, handle } = mount(MATH_SOURCE, (id) => !(disabled && id === MATH_EXTENSION_ID));

    await settle();
    disabled = true;
    notifyCapabilitiesChanged(handle.view);
    await settle();
    expect(parent.querySelector(`.fake-${MATH_EXTENSION_ID}`)).toBeNull();

    disabled = false;
    notifyCapabilitiesChanged(handle.view);
    await settle();

    expect(parent.querySelector(`.fake-${MATH_EXTENSION_ID}`)).not.toBeNull();
  });
});
