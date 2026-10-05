// Import de l'ancien planning Excel (.xlsx/.xlsm) vers le modèle de données
// actuel (employees/vehicles/dossiers/assignments).
//
// Format du fichier source (découvert par inspection, pas documenté ailleurs) :
// - un onglet "EFFECTIFS" avec le référentiel des employés (8 colonnes, une
//   par société : PEL, SJ, AMD, MSN, MJK, TBM, SUP/MRE, OJ) et des véhicules.
// - un onglet par mois ("JANVIER 2026", ...), chacun fait d'un bloc de ~32
//   lignes par jour du mois. Dans un bloc, chaque "chantier" occupe une paire
//   de colonnes (une colonne "numéro" paire, une colonne "donnée" impaire
//   juste à droite — les deux portent souvent la même valeur à cause d'une
//   fusion de cellules dans le fichier d'origine). Les lignes du bloc sont
//   repérées par leur étiquette en colonne G plutôt que par un décalage fixe,
//   parce que la hauteur du bloc varie légèrement (32 ou 33 lignes) selon le
//   mois — un décalage fixe aurait décalé la lecture sur certains jours.
//   Un même chantier peut réapparaître plusieurs jours avec le même
//   "N° dossier" (contrats suivis sur plusieurs semaines/mois) : ces
//   occurrences sont regroupées en un seul dossier avec une ligne
//   d'affectation par jour réel.
const XLSX = require('xlsx');

const MONTHS = [
  ['JANVIER', 1], ['FEVRIER', 2], ['MARS', 3], ['AVRIL', 4], ['MAI', 5], ['JUIN', 6],
  ['JUILLET', 7], ['AOUT', 8], ['SEPTEMBRE', 9], ['OCTOBRE', 10], ['NOVEMBRE', 11], ['DECEMBRE', 12],
];

const LABELS = [
  'TYPE', 'N° dossier', 'Client', 'Coord', 'Adresse départ', 'Adresse arrivée',
  'Tâches', 'Cubage', "Heure d'arrivée", 'Continuité', 'Info supp.', 'J / M / A',
  'H. Requis', 'V. Requis', 'Véhicule', 'Équipe',
];

const EMPLOYEE_PREFIXES = ['PEL', 'SJ', 'AMD', 'MSN', 'MJK', 'TBM', 'MRE', 'SUP', 'OJ'];

function norm(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/\s+/g, ' ');
}

function normKey(v) {
  return norm(v).toUpperCase();
}

function guessCompanyFromName(name) {
  const m = /^([A-Z]+)-/.exec(name);
  if (m && EMPLOYEE_PREFIXES.includes(m[1])) return m[1] === 'MRE' ? 'SUP' : m[1];
  return 'AUTRE';
}

function pad2(n) { return String(n).padStart(2, '0'); }

// A sheet's cells as a sparse grid: grid[row][col] = value (1-based row/col,
// matching how the original file's own rows/columns read in a spreadsheet
// viewer — easier to cross-check against the source file than 0-based math).
function sheetToGrid(sheet) {
  const grid = {};
  if (!sheet['!ref']) return { grid, maxRow: 0, maxCol: 0 };
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell || cell.v === undefined || cell.v === null || cell.v === '') continue;
      const row = R + 1, col = C + 1;
      (grid[row] || (grid[row] = {}))[col] = cell.v;
    }
  }
  return { grid, maxRow: range.e.r + 1, maxCol: range.e.c + 1 };
}

function parseRoster(workbook) {
  const employees = []; // {name, company}
  const vehicles = []; // {name}
  const sheet = workbook.Sheets['EFFECTIFS'];
  if (!sheet) return { employees, vehicles };
  const { grid, maxRow } = sheetToGrid(sheet);
  const pools = { 6: 'PEL', 8: 'SJ', 10: 'AMD', 12: 'MSN', 14: 'MJK', 16: 'TBM', 18: 'SUP', 20: 'OJ' };
  const seenEmp = new Set();
  const seenVeh = new Set();
  for (let r = 4; r <= maxRow; r++) {
    const row = grid[r];
    if (!row) continue;
    for (const col of Object.keys(pools)) {
      const name = norm(row[col]);
      // The sheet's own convention is "CODE-NOM Prénom" (see "Mode d'emploi");
      // a handful of rows just hold the bare company code as a placeholder
      // (e.g. a lone "MJK") instead of a real person — not a dash means not
      // an individual, skip it.
      if (!name || name === '-' || name === '.' || name === '0' || !name.includes('-')) continue;
      const key = normKey(name);
      if (seenEmp.has(key)) continue;
      seenEmp.add(key);
      employees.push({ name, company: pools[col] });
    }
    const veh = row[22];
    if (veh !== undefined) {
      const name = norm(veh);
      if (name && name !== '-' && !seenVeh.has(normKey(name))) {
        seenVeh.add(normKey(name));
        vehicles.push({ name });
      }
    }
  }
  return { employees, vehicles };
}

// One month sheet -> raw per-day-slot entries. Each entry is one "chantier"
// cell seen on one specific day; grouping by N° dossier happens afterwards,
// across every month, since a dossier can span a month boundary.
function parseMonthSheet(workbook, sheetName, month, warnings) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  const { grid, maxCol } = sheetToGrid(sheet);
  const rows = Object.keys(grid).map(Number).sort((a, b) => a - b);
  const blockStarts = rows.filter(r => grid[r] && grid[r][1] === 'EFFECTIFS');
  const lastRow = rows.length ? rows[rows.length - 1] : 0;
  const entries = [];

  for (let bi = 0; bi < blockStarts.length; bi++) {
    const r0 = blockStarts[bi];
    const rEnd = bi + 1 < blockStarts.length ? blockStarts[bi + 1] : lastRow + 1;
    const dayNum = grid[r0 + 1] && grid[r0 + 1][5];
    if (typeof dayNum !== 'number') continue;
    let dateStr;
    try {
      const d = new Date(2026, month - 1, dayNum);
      if (d.getMonth() !== month - 1) continue; // e.g. "31" on a 30-day month
      dateStr = `2026-${pad2(month)}-${pad2(dayNum)}`;
    } catch (e) { continue; }

    const labelRow = {};
    for (let r = r0; r < Math.min(rEnd, r0 + 40); r++) {
      const v = grid[r] && grid[r][7];
      if (v && LABELS.includes(v) && !(v in labelRow)) labelRow[v] = r;
    }
    if (!('Client' in labelRow)) continue;

    const vehiculeRowStart = labelRow['Véhicule'];
    const equipeRowStart = labelRow['Équipe'];

    for (let dataCol = 9; dataCol <= maxCol; dataCol += 2) {
      const headerCol = dataCol - 1;
      const client = norm(grid[labelRow['Client']] && grid[labelRow['Client']][dataCol]);
      if (!client || ['DEPOT', 'GARAGE', '-'].includes(client.toUpperCase())) continue;

      const get = (label, col) => {
        const r = labelRow[label];
        if (r === undefined) return '';
        return norm(grid[r] && grid[r][col]);
      };
      const dossierNumber = get('N° dossier', dataCol) || get('N° dossier', headerCol);

      const vehiclesToday = [];
      if (vehiculeRowStart && equipeRowStart) {
        for (let r = vehiculeRowStart; r < equipeRowStart; r++) {
          for (const col of [dataCol, headerCol]) {
            const v = norm(grid[r] && grid[r][col]);
            if (v && !vehiclesToday.includes(v)) vehiclesToday.push(v);
          }
        }
      }
      const crewToday = [];
      if (equipeRowStart) {
        for (let r = equipeRowStart; r < rEnd; r++) {
          const seenThisRow = [];
          for (const col of [headerCol, dataCol]) {
            const v = norm(grid[r] && grid[r][col]);
            if (v && !seenThisRow.includes(v)) seenThisRow.push(v);
          }
          for (const v of seenThisRow) if (!crewToday.includes(v)) crewToday.push(v);
        }
      }

      entries.push({
        date: dateStr,
        dossierNumber,
        client,
        moveType: get('TYPE', dataCol),
        coordinator: get('Coord', dataCol),
        addressFrom: get('Adresse départ', dataCol),
        addressTo: get('Adresse arrivée', dataCol),
        task: get('Tâches', dataCol),
        cubage: get('Cubage', dataCol),
        arrivalTime: get("Heure d'arrivée", dataCol),
        slot: get('J / M / A', dataCol),
        info: get('Info supp.', dataCol),
        hRequis: get('H. Requis', dataCol),
        vRequis: get('V. Requis', dataCol),
        vehicles: vehiclesToday,
        crew: crewToday,
      });
    }
  }
  return entries;
}

// Groups every per-day entry across all months into one record per actual
// dossier. Entries that share a non-empty N° dossier are the same dossier
// (recurring contracts come back on non-consecutive days under the same
// number); entries without one are each their own one-day dossier.
function groupIntoDossiers(allEntries, warnings) {
  const byNumber = new Map();
  let anonIndex = 0;
  const dossiers = [];
  for (const e of allEntries) {
    let bucket;
    if (e.dossierNumber) {
      bucket = byNumber.get(e.dossierNumber);
      if (!bucket) {
        bucket = { dossierNumber: e.dossierNumber, entries: [] };
        byNumber.set(e.dossierNumber, bucket);
        dossiers.push(bucket);
      }
    } else {
      anonIndex += 1;
      bucket = { dossierNumber: '', entries: [] };
      dossiers.push(bucket);
    }
    bucket.entries.push(e);
  }
  for (const bucket of dossiers) {
    const clients = new Set(bucket.entries.map(e => e.client));
    if (clients.size > 1 && bucket.dossierNumber) {
      warnings.push(`Le n° de dossier "${bucket.dossierNumber}" est utilisé pour plusieurs clients différents (${[...clients].join(', ')}) — vérifier après import.`);
    }
  }
  return dossiers;
}

function firstNonEmpty(entries, field) {
  for (const e of entries) if (e[field]) return e[field];
  return '';
}

function isWeekendDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function parseVRequis(vRequisValues) {
  // Codes seen in the source file: "1C" (camion/PL), "1F" (fourgon), "1VL"
  // (véhicule léger) — sometimes combined on one dossier across its days.
  let plannedFourgon = 0, plannedPL = 0, plannedVL = 0;
  for (const raw of vRequisValues) {
    const re = /(\d+)\s*(VL|PL|C|F)/gi;
    let m;
    while ((m = re.exec(raw))) {
      const n = parseInt(m[1], 10);
      const code = m[2].toUpperCase();
      if (code === 'VL') plannedVL = Math.max(plannedVL, n);
      else if (code === 'F') plannedFourgon = Math.max(plannedFourgon, n);
      else plannedPL = Math.max(plannedPL, n);
    }
  }
  return { plannedFourgon, plannedPL, plannedVL };
}

// Main entry point: parses the whole workbook buffer into a plan of what to
// create (does not touch the database — see server.js for that).
function parseLegacyWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const warnings = [];

  const roster = parseRoster(workbook);

  const allEntries = [];
  for (const [prefix, monthNum] of MONTHS) {
    const sheetName = Object.keys(workbook.Sheets).find(n => n.toUpperCase().startsWith(prefix));
    if (!sheetName) { warnings.push(`Onglet du mois "${prefix}" introuvable — ignoré.`); continue; }
    allEntries.push(...parseMonthSheet(workbook, sheetName, monthNum, warnings));
  }

  const dossierBuckets = groupIntoDossiers(allEntries, warnings);

  // Any crew/vehicle name referenced in the day-by-day grid but missing from
  // the EFFECTIFS roster still needs an employee/vehicle record to assign it
  // to — the roster tab is the common case, not a guarantee of completeness.
  const rosterEmpKeys = new Set(roster.employees.map(e => normKey(e.name)));
  const rosterVehKeys = new Set(roster.vehicles.map(v => normKey(v.name)));
  const extraEmployees = [];
  const extraVehicles = [];
  const unrecognizedCrewNames = new Set();
  for (const e of allEntries) {
    for (const name of e.crew) {
      const key = normKey(name);
      if (rosterEmpKeys.has(key)) continue;
      if (!EMPLOYEE_PREFIXES.some(p => name.toUpperCase().startsWith(p + '-'))) {
        unrecognizedCrewNames.add(name);
        continue;
      }
      if (!extraEmployees.some(x => normKey(x.name) === key)) {
        extraEmployees.push({ name, company: guessCompanyFromName(name.toUpperCase()) });
      }
    }
    for (const name of e.vehicles) {
      const key = normKey(name);
      if (rosterVehKeys.has(key) || extraVehicles.some(x => normKey(x.name) === key)) continue;
      extraVehicles.push({ name });
    }
  }
  if (unrecognizedCrewNames.size) {
    warnings.push(`${unrecognizedCrewNames.size} entrée(s) dans les équipes ne ressemblent à aucun nom d'employé connu et ont été ignorées (ex: ${[...unrecognizedCrewNames].slice(0, 5).join(', ')}).`);
  }
  const fraikinVariants = new Set([...rosterVehKeys, ...extraVehicles.map(v => normKey(v.name))].values());
  const fraikinOnes = [...fraikinVariants].filter(v => v.startsWith('FRAIKIN'));
  if (fraikinOnes.length > 1) {
    warnings.push(`Plusieurs noms de véhicule proches ont été trouvés pour "FRAIKIN" (${fraikinOnes.join(', ')}) — probablement le même véhicule saisi différemment selon les mois ; à fusionner manuellement dans Véhicules après import si besoin.`);
  }

  const dossiers = dossierBuckets.map((bucket, i) => {
    const entries = bucket.entries.sort((a, b) => a.date < b.date ? -1 : 1);
    const dates = entries.map(e => e.date);
    const { plannedFourgon, plannedPL, plannedVL } = parseVRequis(entries.map(e => e.vRequis).filter(Boolean));
    const hRequisValues = entries.map(e => parseInt(e.hRequis, 10)).filter(n => !isNaN(n));
    return {
      dossierNumber: bucket.dossierNumber,
      client: firstNonEmpty(entries, 'client'),
      moveType: firstNonEmpty(entries, 'moveType'),
      coordinator: firstNonEmpty(entries, 'coordinator'),
      addressFrom: firstNonEmpty(entries, 'addressFrom'),
      addressTo: firstNonEmpty(entries, 'addressTo'),
      task: firstNonEmpty(entries, 'task'),
      volume: firstNonEmpty(entries, 'cubage'),
      comment: firstNonEmpty(entries, 'info'),
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      workWeekends: dates.some(isWeekendDate),
      plannedEmployees: hRequisValues.length ? Math.max(...hRequisValues) : 0,
      plannedFourgon, plannedPL, plannedVL,
      days: entries.map(e => ({
        date: e.date,
        crew: e.crew,
        vehicles: e.vehicles,
        arrivalTime: e.arrivalTime,
        slot: e.slot,
      })),
    };
  });

  return {
    employees: [...roster.employees, ...extraEmployees],
    vehicles: [...roster.vehicles, ...extraVehicles],
    dossiers,
    warnings,
    stats: {
      totalSlotsSeen: allEntries.length,
      uniqueDossiers: dossiers.length,
      employeesFound: roster.employees.length + extraEmployees.length,
      vehiclesFound: roster.vehicles.length + extraVehicles.length,
    },
  };
}

module.exports = { parseLegacyWorkbook, normKey, guessCompanyFromName };
