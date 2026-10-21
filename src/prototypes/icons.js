// One consistent icon family for the sample site: 24px grid, 2.25 stroke,
// square caps, no fills. Inline SVG only (the page loads nothing remote).

const P = {
  wrench: 'M14.5 4.5a4.5 4.5 0 0 0-5.6 5.6L3.5 15.5l5 5 5.4-5.4a4.5 4.5 0 0 0 5.6-5.6l-2.8 2.8-3.2-.6-.6-3.2z',
  drain: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 8a4 4 0 1 1-4 4M12 12h.01',
  drop: 'M12 3s6.5 7.2 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.2 12 3 12 3z',
  heater: 'M7 3.5h10v15H7zM7 8h10M10 21v-2.5M14 21v-2.5M12 11.5v3',
  pipe: 'M3 7.5h8.5a5 5 0 0 1 5 5V21M3 14h5a2 2 0 0 1 2 2v5',
  faucet: 'M4 10.5h9a3 3 0 0 1 3 3V16M8.5 10.5V7.5h4v3M6 7.5h9M16 19.5v.5',
  softener: 'M8 3.5h8v17H8zM8 9.5h8M12 13.5v3',
  snowflake: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5',
  flame: 'M12 3c1.2 4 5.5 5.2 5.5 10.5a5.5 5.5 0 0 1-11 0c0-3 1.8-4.6 2.2-7.3 1.4 1 2.6 2.6 2.6 2.6S13.3 6.3 12 3z',
  unit: 'M3 5.5h18v13H3zM12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0M12 8v8M8 12h8',
  thermostat: 'M12 3a3 3 0 0 0-3 3v8.2a4.5 4.5 0 1 0 6 0V6a3 3 0 0 0-3-3zM12 10v7',
  fan: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M12 10c0-4 1-7 4-7 2 0 2 3-2 7M14 12c4 0 7 1 7 4 0 2-3 2-7-2M12 14c0 4-1 7-4 7-2 0-2-3 2-7M10 12c-4 0-7-1-7-4 0-2 3-2 7 2',
  duct: 'M3 7.5h12l6 4V20M3 14h9l3 2v4',
  bolt: 'M13 2.5 4.5 14h7l-1 7.5L19 10h-7z',
  panel: 'M5 3h14v18H5zM9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  outlet: 'M5 3.5h14v17H5zM10 9v3M14 9v3M12 15.5v1',
  check: 'M5 12.5 10 17 19 7',
  house: 'M3 11 12 4l9 7M5.5 9.5V20h13V9.5M10 20v-6h4v6',
  leaf: 'M5 19.5c0-9 6-14.5 15-14.5 0 9-5.5 15-14.5 15M5 19.5l8-8',
  clipboard: 'M8.5 3.5h7v3h-7zM6.5 5H5v16h14V5h-1.5M9 12h6M9 16h4',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z',
  chat: 'M4 4.5h16v11.5H9.5L4 20.5z',
  calendar: 'M4 5.5h16v15H4zM4 10h16M8 3v4M16 3v4',
  pin: 'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12zM12 9m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  award: 'M12 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM8.5 14 7 21l5-2.5 5 2.5-1.5-7',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2',
  scissors: 'M6 6m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M6 18m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M8.2 7.4 20 18M8.2 16.6 20 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  mail: 'M3.5 5.5h17v13h-17zM3.5 6l8.5 7 8.5-7',
};

function icon(name, cls = 'ic') {
  const d = P[name] || P.wrench;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

// Hero line art: a service van in front of a house outline, drawn as strokes
// so it sits at low opacity on the brand block.
const VAN = `<svg class="hero-art" viewBox="0 0 520 260" aria-hidden="true" focusable="false">
<path d="M300 120 380 60l80 60M316 108v92h128v-92M366 200v-48h28v48M330 128h24v20h-24zM406 128h24v20h-24z"/>
<path d="M30 210V110h210v100M240 132h66l38 34v44H240M260 140h40l24 26h-64zM30 98h196M54 86v12M204 86v12M30 150h210"/>
<path d="M78 210a22 22 0 1 0 44 0 22 22 0 1 0-44 0M268 210a22 22 0 1 0 44 0 22 22 0 1 0-44 0M10 232h500"/>
</svg>`;

module.exports = { icon, VAN };
