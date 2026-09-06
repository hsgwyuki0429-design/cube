/** DOM ヘルパ。フェーズ0では素の DOM を使う（React/Preact は入れない）。 */

type Props = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'style') Object.assign(node.style, v as object);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in node) (node as unknown as Props)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function section(title: string, collapsed = false): { root: HTMLElement; body: HTMLElement } {
  const body = el('div', { class: 'body' });
  const h = el('h2', {}, [title]);
  const root = el('div', { class: collapsed ? 'sec collapsed' : 'sec' }, [h, body]);
  h.addEventListener('click', () => root.classList.toggle('collapsed'));
  return { root, body };
}

export function kv(rows: [string, string][]): HTMLTableElement {
  return el(
    'table',
    { class: 'kv' },
    rows.map(([k, v]) => el('tr', {}, [el('td', {}, [k]), el('td', {}, [v])])),
  ) as HTMLTableElement;
}

/** ラベル + スライダ + 数値表示。閾値チューニング用。 */
export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (v: number) => void,
): HTMLElement {
  const out = el('span', { style: { minWidth: '46px', textAlign: 'right' } }, [value.toFixed(3)]);
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = step >= 1 ? String(v) : v.toFixed(3);
      onChange(v);
    },
  });
  return el('div', { class: 'row' }, [el('label', {}, [label]), input, out]);
}

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}
