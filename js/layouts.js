/*
 * Physical key layouts for every supported DrunkDeer model.
 * Each key: [matrixIndex, label, widthInUnits, flags]
 * The matrix index is the position the firmware uses (0..125), taken from the
 * original web driver, so selections map 1:1 to profile.keys_array[index].
 * A row item of the form {gap: w} is empty space; {knob: true} is the rotary knob.
 */
(function () {
  const g = (w) => ({ gap: w });
  const knob = { knob: true };
  const k = (i, label, w = 1, flags) => ({ i, label, w, flags: flags || '' });
  const seq = (start, labels) => labels.map((l, n) => k(start + n, l));

  const ACC = 'accent';

  // ---------- 75% ANSI (A75 / A75 Pro) ----------
  const A75 = {
    cols: 16,
    rows: [
      [k(0, 'Esc', 1, ACC), g(0.25), ...seq(2, ['F1', 'F2', 'F3', 'F4']), g(0.25), ...seq(6, ['F5', 'F6', 'F7', 'F8']), g(0.25),
        ...seq(10, ['F9', 'F10', 'F11', 'F12']), g(0.25), k(14, 'Del'), knob],
      [...seq(21, ['~', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '+']), k(34, 'Back', 2), k(36, 'Home')],
      [k(42, 'Tab', 1.5), ...seq(43, ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']']), k(55, '\\', 1.5), k(57, 'PgUp')],
      [k(63, 'CapsLk', 1.75), ...seq(64, ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '‘']), k(76, 'Enter', 2.25, ACC), k(78, 'PgDn')],
      [k(84, 'Shift', 2.25), ...seq(86, ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']), k(97, 'Shift', 1.75), k(98, '@up'), k(99, 'End')],
      [k(105, 'Ctrl', 1.25), k(106, 'Win', 1.25), k(107, 'Alt', 1.25), k(111, 'Space', 6.25, ACC), k(115, 'Alt'), k(116, 'Fn'), k(117, 'Menu'),
        k(119, '@left'), k(120, '@down'), k(121, '@right')],
    ],
  };

  // ---------- 75% ISO variants (A75 UK / FR / DE) ----------
  function iso75(o) {
    return {
      cols: 16,
      rows: [
        [k(0, o.esc, 1, ACC), g(0.25), ...seq(2, ['F1', 'F2', 'F3', 'F4']), g(0.25), ...seq(6, ['F5', 'F6', 'F7', 'F8']), g(0.25),
          ...seq(10, ['F9', 'F10', 'F11', 'F12']), g(0.25), k(14, o.del), knob],
        [...seq(21, o.r1), k(34, 'Back', 2), k(36, o.home)],
        [k(42, 'Tab', 1.5), ...seq(43, o.r2), k(76, 'Enter', 1.5, ACC + ' iso-top'), k(57, o.pgup)],
        [k(63, 'CapsLk', 1.75), ...seq(64, o.r3), k(76, 'Enter', 1.25, ACC + ' iso-bottom'), k(78, o.pgdn)],
        [k(84, 'Shift', 1.25), ...seq(85, o.r4), k(97, 'Shift', 1.75), k(98, '@up'), k(99, o.end)],
        [k(105, o.ctrl, 1.25), k(106, 'Win', 1.25), k(107, 'Alt', 1.25), k(111, 'Space', 6.25, ACC), k(115, 'AltGr'), k(116, 'Fn'), k(117, 'Menu'),
          k(119, '@left'), k(120, '@down'), k(121, '@right')],
      ],
    };
  }
  const A75_UK = iso75({
    esc: 'Esc', del: 'Del', home: 'Home', pgup: 'PgUp', pgdn: 'PgDn', end: 'End', ctrl: 'Ctrl',
    r1: ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
    r2: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'],
    r3: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", '#'],
    r4: ['\\', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
  });
  const A75_DE = iso75({
    esc: 'Esc', del: 'Entf', home: 'Pos1', pgup: 'Bild↑', pgdn: 'Bild↓', end: 'Ende', ctrl: 'Strg',
    r1: ['^', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'ß', '´'],
    r2: ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü', '+'],
    r3: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä', '#'],
    r4: ['<', 'y', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '-'],
  });
  const A75_FR = iso75({
    esc: 'Echap', del: 'Suppr', home: 'Début', pgup: 'Pg↑', pgdn: 'Pg↓', end: 'Fin', ctrl: 'Ctrl',
    r1: ['²', '&', 'é', '"', "'", '(', '-', 'è', '_', 'ç', 'à', ')', '='],
    r2: ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '^', '$'],
    r3: ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'ù', '*'],
    r4: ['<', 'w', 'x', 'c', 'v', 'b', 'n', ',', ';', ':', '!'],
  });

  // ---------- G75 ----------
  const G75 = {
    cols: 16,
    rows: [
      [k(0, 'Esc', 1, ACC), ...seq(1, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']), k(13, 'PrtSc'), k(14, 'Ins'), k(15, 'Del')],
      [...seq(21, ['~', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '+']), k(34, 'Back', 2), k(36, 'Home')],
      [k(42, 'Tab', 1.5), ...seq(43, ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']']), k(55, '\\', 1.5), k(57, 'PgUp')],
      [k(63, 'CapsLk', 1.75), ...seq(64, ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '‘']), k(76, 'Enter', 2.25, ACC), k(78, 'PgDn')],
      [k(84, 'Shift', 2.25), ...seq(86, ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']), k(96, 'Shift', 1.75), k(97, '@up'), k(99, 'End')],
      [k(105, 'Ctrl', 1.25), k(106, 'Win', 1.25), k(107, 'Alt', 1.25), k(111, 'Space', 6.25, ACC), k(114, 'Alt'), k(115, 'Fn'), k(117, 'Menu'),
        k(118, '@left'), k(119, '@down'), k(120, '@right')],
    ],
  };

  const G75JP = {
    cols: 16,
    rows: [
      G75.rows[0],
      [k(21, '半/全'), ...seq(22, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '^', '¥']), k(35, 'Back'), k(36, 'Home')],
      [k(42, 'Tab', 1.5), ...seq(43, ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '@', '[']), k(77, 'Enter', 1.5, ACC + ' iso-top'), k(57, 'PgUp')],
      [k(63, 'CapsLk', 1.75), ...seq(64, ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', ':', ']']), k(77, 'Enter', 1.25, ACC + ' iso-bottom'), k(78, 'PgDn')],
      [k(84, 'Shift', 1.75), ...seq(86, ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', '\\']), k(97, 'Shift', 1.25), k(98, '@up'), k(99, 'End')],
      [k(105, 'Ctrl', 1.25), k(106, 'Win', 1.25), k(107, 'Alt', 1.25), k(111, 'Space', 6.25, ACC), k(114, 'Alt'), k(115, 'Fn'), k(117, 'Ctrl'),
        k(118, '@left'), k(119, '@down'), k(120, '@right')],
    ],
  };

  // ---------- 65% (G65 / G65 Lite) ----------
  const G65 = {
    cols: 16,
    rows: [
      [k(21, 'Esc', 1, ACC), ...seq(22, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '+']), k(34, 'Back', 2), k(35, 'Del')],
      [k(42, 'Tab', 1.5), ...seq(43, ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']']), k(55, '\\', 1.5), k(56, 'End')],
      [k(63, 'CapsLk', 1.75), ...seq(64, ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '‘']), k(76, 'Enter', 2.25, ACC), k(77, 'PgUp')],
      [k(84, 'Shift', 2.25), ...seq(86, ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']), k(96, 'Shift', 1.75), k(97, '@up'), k(98, 'PgDn')],
      [k(105, 'Ctrl', 1.25), k(106, 'Win', 1.25), k(107, 'Alt', 1.25), k(111, 'Space', 6.25, ACC), k(114, 'Alt'), k(115, 'Fn'), k(116, 'Fn2'),
        k(117, '@left'), k(118, '@down'), k(119, '@right')],
    ],
  };

  // ---------- 60% (G60) ----------
  const G60 = {
    cols: 15,
    rows: [
      [k(21, 'Esc', 1, ACC), ...seq(22, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '+']), k(34, 'Back', 2)],
      [k(42, 'Tab', 1.5), ...seq(43, ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']']), k(55, '\\', 1.5)],
      [k(63, 'CapsLk', 1.75), ...seq(64, ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '‘']), k(76, 'Enter', 2.25, ACC)],
      [k(84, 'Shift', 2.25), ...seq(86, ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']), k(97, 'Shift', 2.75)],
      [k(105, 'Ctrl', 1.25), k(106, 'Win', 1.25), k(107, 'Alt', 1.25), k(111, 'Space', 6.25, ACC), k(115, 'Alt', 1.25), k(116, 'Fn', 1.25),
        k(117, 'Fn2', 1.25), k(118, 'Ctrl', 1.25)],
    ],
  };

  const MODELS = {
    75: { name: 'A75', layout: A75, family: 'A75' },
    750: { name: 'A75 Pro', layout: A75, family: 'A75' },
    751: { name: 'A75 ISO UK', layout: A75_UK, family: 'A75 ISO' },
    752: { name: 'A75 ISO FR', layout: A75_FR, family: 'A75 ISO' },
    753: { name: 'A75 ISO DE', layout: A75_DE, family: 'A75 ISO' },
    754: { name: 'G75', layout: G75, family: 'G75' },
    755: { name: 'G75 JP', layout: G75JP, family: 'G75 JP' },
    65: { name: 'G65', layout: G65, family: 'G65' },
    650: { name: 'G65 Lite', layout: G65, family: 'G65' },
    60: { name: 'G60', layout: G60, family: 'G60' },
    82: { name: 'K82', layout: A75, family: 'A75' },
  };

  // Physical-keyboard → matrix index (A75-family) used by Demo mode to animate key travel.
  const DEMO_CODES = {
    Escape: 0, F1: 2, F2: 3, F3: 4, F4: 5, F5: 6, F6: 7, F7: 8, F8: 9, F9: 10, F10: 11, F11: 12, F12: 13, Delete: 14,
    Backquote: 21, Digit1: 22, Digit2: 23, Digit3: 24, Digit4: 25, Digit5: 26, Digit6: 27, Digit7: 28, Digit8: 29, Digit9: 30, Digit0: 31,
    Minus: 32, Equal: 33, Backspace: 34, Home: 36, Tab: 42, KeyQ: 43, KeyW: 44, KeyE: 45, KeyR: 46, KeyT: 47, KeyY: 48, KeyU: 49, KeyI: 50,
    KeyO: 51, KeyP: 52, BracketLeft: 53, BracketRight: 54, Backslash: 55, PageUp: 57, CapsLock: 63, KeyA: 64, KeyS: 65, KeyD: 66, KeyF: 67,
    KeyG: 68, KeyH: 69, KeyJ: 70, KeyK: 71, KeyL: 72, Semicolon: 73, Quote: 74, Enter: 76, PageDown: 78, ShiftLeft: 84, KeyZ: 86, KeyX: 87,
    KeyC: 88, KeyV: 89, KeyB: 90, KeyN: 91, KeyM: 92, Comma: 93, Period: 94, Slash: 95, ShiftRight: 97, ArrowUp: 98, End: 99,
    ControlLeft: 105, MetaLeft: 106, AltLeft: 107, Space: 111, AltRight: 115, ContextMenu: 117, ArrowLeft: 119, ArrowDown: 120, ArrowRight: 121,
  };

  window.DDLayouts = { MODELS, DEMO_CODES };
})();
