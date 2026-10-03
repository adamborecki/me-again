// A small modal question. Resolves to the chosen button's value, or null if
// dismissed (Esc / Cancel). Falls back to window.confirm where <dialog> isn't
// supported (OK picks the button marked `confirm: true`).
//
//   const v = await ask({ title, body, buttons: [
//     { label: 'Delete', value: 'delete', kind: 'danger', confirm: true },
//     { label: 'Cancel', value: null },
//   ] });
export function ask({ title, body, buttons }) {
  const dlg = document.createElement('dialog');
  if (typeof dlg.showModal !== 'function') {
    const yes = buttons.find((b) => b.confirm);
    return Promise.resolve(window.confirm(`${title}\n\n${body}`) && yes ? yes.value : null);
  }
  return new Promise((resolve) => {
    dlg.className = 'ask';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    const row = document.createElement('div');
    row.className = 'ask-buttons';
    const done = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      el.className = `ask-btn ${b.kind || ''}`;
      el.addEventListener('click', () => done(b.value ?? null));
      row.append(el);
    }
    dlg.append(h, p, row);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
    // Focus the safe choice (the last button, Cancel by convention).
    row.lastElementChild.focus();
  });
}
