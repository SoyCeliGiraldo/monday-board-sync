#!/usr/bin/env node

const API_URL = "https://api.monday.com/v2";
const API_TOKEN = process.env.MONDAY_API_TOKEN;
const DIRECTORY_BOARD_ID = 18415155198;
const ACCOUNT_SLUG = "redsisrgh";
const DRY_RUN = process.env.DRY_RUN === "true";

const COLUMN_IDS = {
  boardId: "text_mm3rcrs1",
  owners: "text_mm3r6jta",
  emails: "text_mm3re79w",
  url: "link_mm3rab1t",
};

if (!API_TOKEN) {
  console.error("Error: MONDAY_API_TOKEN no está configurado.");
  console.error("Uso: MONDAY_API_TOKEN=tu_token npm run sync");
  process.exit(1);
}

async function mondayApi(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function fetchAllBoards() {
  const allBoards = [];
  let page = 1;

  while (true) {
    console.log(`  Consultando página ${page}...`);
    const data = await mondayApi(
      `query($limit: Int!, $page: Int!) {
        boards(limit: $limit, page: $page, state: active) {
          id
          name
          owners { id name email }
        }
      }`,
      { limit: 50, page }
    );

    if (!data.boards || data.boards.length === 0) break;

    for (const board of data.boards) {
      if (Number(board.id) === DIRECTORY_BOARD_ID) continue;
      allBoards.push(board);
    }

    if (data.boards.length < 50) break;
    page++;
    await sleep(500);
  }

  return allBoards;
}

async function fetchExistingItems() {
  const items = [];
  let cursor = null;

  const colIds = [COLUMN_IDS.boardId, COLUMN_IDS.owners, COLUMN_IDS.emails].map(c => `"${c}"`).join(",");

  const firstPage = await mondayApi(
    `query($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 100) {
          cursor
          items {
            id
            name
            column_values(ids: [${colIds}]) { id text }
          }
        }
      }
    }`,
    { boardId: [String(DIRECTORY_BOARD_ID)] }
  );

  const page = firstPage.boards[0].items_page;
  items.push(...page.items);
  cursor = page.cursor;

  while (cursor) {
    const nextPage = await mondayApi(
      `query($cursor: String!) {
        next_items_page(limit: 100, cursor: $cursor) {
          cursor
          items {
            id
            name
            column_values(ids: [${colIds}]) { id text }
          }
        }
      }`,
      { cursor }
    );
    items.push(...nextPage.next_items_page.items);
    cursor = nextPage.next_items_page.cursor;
    await sleep(300);
  }

  return items;
}

function getColValue(item, colId) {
  return item.column_values.find((c) => c.id === colId)?.text || "";
}

function buildBoardData(board) {
  return {
    name: board.name,
    owners: board.owners.map((o) => o.name).join(", "),
    emails: board.owners.map((o) => o.email).join(", "),
    url: `https://${ACCOUNT_SLUG}.monday.com/boards/${board.id}`,
  };
}

function detectChanges(item, board) {
  const current = buildBoardData(board);
  const changes = {};

  if (item.name !== current.name) changes.name = current.name;
  if (getColValue(item, COLUMN_IDS.owners) !== current.owners)
    changes[COLUMN_IDS.owners] = current.owners;
  if (getColValue(item, COLUMN_IDS.emails) !== current.emails)
    changes[COLUMN_IDS.emails] = current.emails;

  return Object.keys(changes).length > 0 ? changes : null;
}

async function updateItems(updates) {
  const batchSize = 5;
  let updated = 0;

  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    const mutations = batch
      .map(({ itemId, changes, boardUrl }, idx) => {
        const colValues = {};
        if (changes[COLUMN_IDS.owners]) colValues[COLUMN_IDS.owners] = changes[COLUMN_IDS.owners];
        if (changes[COLUMN_IDS.emails]) colValues[COLUMN_IDS.emails] = changes[COLUMN_IDS.emails];
        colValues[COLUMN_IDS.url] = { url: boardUrl, text: "Abrir" };

        const parts = [];

        if (changes.name) {
          const safeName = changes.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          parts.push(
            `n${idx}: change_simple_column_value(item_id: ${itemId}, board_id: ${DIRECTORY_BOARD_ID}, column_id: "name", value: "\\"${safeName}\\"") { id }`
          );
        }

        const colValue = JSON.stringify(colValues)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');
        parts.push(
          `u${idx}: change_multiple_column_values(item_id: ${itemId}, board_id: ${DIRECTORY_BOARD_ID}, column_values: "${colValue}") { id }`
        );

        return parts.join("\n");
      })
      .join("\n");

    await mondayApi(`mutation { ${mutations} }`);
    updated += batch.length;
    console.log(`   Actualizados ${updated}/${updates.length}`);
    await sleep(500);
  }
}

async function ensureUrls(items, boardMap) {
  const missing = items.filter((item) => {
    const boardId = getColValue(item, COLUMN_IDS.boardId);
    return boardId && boardMap.has(boardId);
  });

  if (missing.length === 0) return;

  console.log(`   Verificando URLs en ${missing.length} ítems existentes...`);
  const batchSize = 5;
  let done = 0;

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const mutations = batch
      .map((item, idx) => {
        const boardId = getColValue(item, COLUMN_IDS.boardId);
        const boardUrl = `https://${ACCOUNT_SLUG}.monday.com/boards/${boardId}`;
        const colValue = JSON.stringify({
          [COLUMN_IDS.url]: { url: boardUrl, text: "Abrir" },
        }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `u${idx}: change_multiple_column_values(item_id: ${item.id}, board_id: ${DIRECTORY_BOARD_ID}, column_values: "${colValue}") { id }`;
      })
      .join("\n");
    await mondayApi(`mutation { ${mutations} }`);
    done += batch.length;
    if (done % 50 === 0 || done === missing.length)
      console.log(`   URLs ${done}/${missing.length}`);
    await sleep(500);
  }
}

async function createItems(boards) {
  const batchSize = 8;
  let created = 0;

  for (let i = 0; i < boards.length; i += batchSize) {
    const batch = boards.slice(i, i + batchSize);
    const mutations = batch
      .map((board, idx) => {
        const data = buildBoardData(board);
        const colValues = JSON.stringify({
          [COLUMN_IDS.boardId]: board.id,
          [COLUMN_IDS.owners]: data.owners,
          [COLUMN_IDS.emails]: data.emails,
          [COLUMN_IDS.url]: { url: data.url, text: "Abrir" },
        }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

        const safeName = board.name
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');

        return `c${idx}: create_item(board_id: ${DIRECTORY_BOARD_ID}, item_name: "${safeName}", column_values: "${colValues}") { id }`;
      })
      .join("\n");

    await mondayApi(`mutation { ${mutations} }`);
    created += batch.length;
    console.log(`   Creados ${created}/${boards.length}`);
    await sleep(600);
  }

  return created;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Monday.com Board Directory Sync ===\n");

  if (DRY_RUN) console.log("** MODO DRY-RUN: no se harán cambios **\n");

  console.log("1. Consultando todos los tableros de la cuenta...");
  const boards = await fetchAllBoards();
  const boardMap = new Map(boards.map((b) => [b.id, b]));
  console.log(`   Total: ${boards.length} tableros encontrados.\n`);

  console.log("2. Consultando ítems existentes en el directorio...");
  const existing = await fetchExistingItems();
  console.log(`   Total: ${existing.length} ítems existentes.\n`);

  const existingByBoardId = new Map();
  for (const item of existing) {
    const bid = getColValue(item, COLUMN_IDS.boardId);
    if (bid) existingByBoardId.set(bid, item);
  }

  const toAdd = boards.filter((b) => !existingByBoardId.has(b.id));

  const toUpdate = [];
  for (const [bid, item] of existingByBoardId) {
    const board = boardMap.get(bid);
    if (!board) continue;
    const changes = detectChanges(item, board);
    if (changes) {
      toUpdate.push({
        itemId: item.id,
        itemName: item.name,
        changes,
        boardUrl: `https://${ACCOUNT_SLUG}.monday.com/boards/${bid}`,
      });
    }
  }

  const orphaned = [...existingByBoardId.entries()]
    .filter(([bid]) => !boardMap.has(bid))
    .map(([bid, item]) => ({ itemId: item.id, itemName: item.name, boardId: bid }));

  console.log(`3. Resumen de cambios:`);
  console.log(`   - Nuevos por agregar: ${toAdd.length}`);
  console.log(`   - Con cambios (nombre/dueños): ${toUpdate.length}`);
  console.log(`   - Tableros eliminados (huérfanos): ${orphaned.length}`);
  console.log(`   - Sin cambios: ${existing.length - toUpdate.length - orphaned.length}\n`);

  if (DRY_RUN) {
    if (toAdd.length > 0) {
      console.log("   Tableros nuevos:");
      toAdd.slice(0, 10).forEach((b) => console.log(`     + ${b.name} (${b.id})`));
      if (toAdd.length > 10) console.log(`     ... y ${toAdd.length - 10} más`);
    }
    if (toUpdate.length > 0) {
      console.log("\n   Tableros con cambios:");
      toUpdate.slice(0, 10).forEach(({ itemName, changes }) => {
        const fields = Object.keys(changes).join(", ");
        console.log(`     ~ ${itemName} → cambios en: ${fields}`);
      });
      if (toUpdate.length > 10) console.log(`     ... y ${toUpdate.length - 10} más`);
    }
    if (orphaned.length > 0) {
      console.log("\n   Huérfanos (tablero ya no existe, NO se eliminan del directorio):");
      orphaned.forEach(({ itemName, boardId }) =>
        console.log(`     ? ${itemName} (board ${boardId})`)
      );
    }
    console.log("\nDry-run finalizado. Ejecuta sin DRY_RUN para aplicar.");
    return;
  }

  if (toUpdate.length > 0) {
    console.log("4. Actualizando ítems con cambios...");
    await updateItems(toUpdate);
    console.log("   Hecho.\n");
  }

  if (existing.length > 0) {
    console.log("5. Asegurando URLs en ítems existentes...");
    await ensureUrls(existing, boardMap);
    console.log("   Hecho.\n");
  }

  if (toAdd.length > 0) {
    console.log("6. Agregando tableros nuevos...");
    await createItems(toAdd);
    console.log("   Hecho.\n");
  }

  if (orphaned.length > 0) {
    console.log("NOTA: Los siguientes ítems corresponden a tableros que ya no existen.");
    console.log("      NO se eliminan para preservar datos de revisión/justificación.");
    orphaned.forEach(({ itemName, boardId }) =>
      console.log(`      ? ${itemName} (board ${boardId})`)
    );
    console.log();
  }

  console.log("=== Sincronización completada ===");
  console.log(`   Ítems actualizados: ${toUpdate.length}`);
  console.log(`   Ítems nuevos: ${toAdd.length}`);
  console.log(`   Total en directorio: ${existing.length + toAdd.length}`);
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});
