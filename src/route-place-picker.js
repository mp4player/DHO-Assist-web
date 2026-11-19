const searchKey = text => text.trim().normalize('NFC').toLocaleLowerCase('ko-KR');

export function createPlacePicker(input) {
  const field = input.closest('.place-picker');
  const toggle = field.querySelector('button');
  const menu = field.querySelector('.place-picker-menu');
  const list = field.querySelector('[role="listbox"]');
  const empty = field.querySelector('.place-picker-empty');
  const routePanel = input.closest('details');
  routePanel?.addEventListener('toggle', () => { if (!routePanel.open) close(); });
  let items = [];
  let selected = null;
  let editing = false;
  let matches = [];
  let options = [];
  let active = -1;

  function close() {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function select(item) {
    selected = item;
    editing = false;
    input.value = item?.name ?? '';
    close();
  }

  function show() {
    if (input.disabled) return;
    const query = !editing && input.value === selected?.name ? '' : searchKey(input.value);
    matches = items.filter(item => item.key.includes(query));
    active = -1;
    input.removeAttribute('aria-activedescendant');
    const fragment = document.createDocumentFragment();
    let group;
    let previousCategory;
    options = matches.map((item, index) => {
      if (item.category && item.category !== previousCategory) {
        group = document.createElement('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', item.category);
        const caption = document.createElement('div');
        caption.className = 'place-picker-group';
        caption.setAttribute('aria-hidden', 'true');
        caption.textContent = item.category;
        group.append(caption);
        fragment.append(group);
        previousCategory = item.category;
      }
      const option = document.createElement('div');
      option.id = `${list.id}-${index}`;
      option.dataset.index = index;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.textContent = item.name;
      (item.category ? group : fragment).append(option);
      return option;
    });
    list.replaceChildren(fragment);
    empty.hidden = matches.length > 0;
    menu.hidden = false;
    menu.scrollTop = 0;
    input.setAttribute('aria-expanded', 'true');
  }

  function open() {
    show();
    if (!editing && selected && input.value === selected.name) input.select();
  }

  input.addEventListener('click', () => { if (menu.hidden) open(); });
  input.addEventListener('input', () => { editing = true; show(); });
  field.addEventListener('focusout', event => { if (!field.contains(event.relatedTarget)) close(); });
  toggle.addEventListener('mousedown', event => event.preventDefault());
  toggle.onclick = () => {
    input.focus();
    if (menu.hidden) open();
    else close();
  };
  list.addEventListener('mousedown', event => { if (event.target.closest('[role="option"]')) event.preventDefault(); });
  list.onclick = event => {
    const option = event.target.closest('[role="option"]');
    if (option) select(matches[Number(option.dataset.index)]);
  };
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) open();
      if (!options.length) return;
      options[active]?.setAttribute('aria-selected', 'false');
      active = event.key === 'ArrowDown' ? Math.min(active + 1, options.length - 1)
        : active < 0 ? options.length - 1 : Math.max(active - 1, 0);
      const option = options[active];
      option.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({block: 'nearest'});
    } else if (event.key === 'Enter' && !menu.hidden) {
      event.preventDefault();
      const item = matches[active] ?? (matches.length === 1 ? matches[0] : exactMatch());
      if (item) select(item);
    } else if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      select(selected);
    }
  });

  function exactMatch() {
    const query = searchKey(input.value);
    const exact = items.filter(item => item.key === query);
    return exact.length === 1 ? exact[0] : null;
  }

  return {
    setItems(choices) {
      items = choices.map(item => ({...item, key: searchKey(item.name)}));
      if (selected && !items.some(item => item.id === selected.id)) {
        if (editing) selected = null;
        else select(null);
      }
      if (!menu.hidden) show();
    },
    setDisabled(disabled) {
      input.disabled = toggle.disabled = disabled;
      if (disabled) close();
    },
    get value() {
      const item = input.value === selected?.name ? selected : exactMatch();
      if (item && item !== selected) select(item);
      return item?.id ?? null;
    },
  };
}
