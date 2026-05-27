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

  const firstPage = await mondayApi(
    `query($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 100) {
          cursor
          items { id column_values(ids: ["${COLUMN_IDS.boardId}"]) { text } }
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
          items { id column_values(ids: ["${COLUMN_IDS.boardId}"]) { text } }
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

async function deleteItems(itemIds) {
  const batchSize = 10;
  for (let i = 0; i < itemIds.length; i += batchSize) {
    const batch = itemIds.slice(i, i + batchSize);
    const mutations = batch
      .map((id, idx) => `d${idx}: delete_item(item_id: ${id}) { id }`)
      .join("\n");
    await mondayApi(`mutation { ${mutations} }`);
    console.log(`  Eliminados ${Math.min(i + batchSize, itemIds.length)}/${itemIds.length}`);
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
        const ownerNames = board.owners.map((o) => o.name).join(", ");
        const ownerEmails = board.owners.map((o) => o.email).join(", ");
        const boardUrl = `https://${ACCOUNT_SLUG}.monday.com/boards/${board.id}`;
        const colValues = JSON.stringify({
          [COLUMN_IDS.boardId]: board.id,
          [COLUMN_IDS.owners]: ownerNames,
          [COLUMN_IDS.emails]: ownerEmails,
          [COLUMN_IDS.url]: { url: boardUrl, text: "Abrir" },
        }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

        const safeName = board.name
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');

        return `c${idx}: create_item(board_id: ${DIRECTORY_BOARD_ID}, item_name: "${safeName}", column_values: "${colValues}") { id }`;
      })
      .join("\n");

    await mondayApi(`mutation { ${mutations} }`);
    created += batch.length;
    console.log(`  Creados ${created}/${boards.length}`);
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
  console.log(`   Total: ${boards.length} tableros encontrados.\n`);

  console.log("2. Consultando ítems existentes en el directorio...");
  const existing = await fetchExistingItems();
  console.log(`   Total: ${existing.length} ítems existentes.\n`);

  const existingBoardIds = new Set(
    existing.map((item) => item.column_values[0]?.text).filter(Boolean)
  );
  const liveBoardIds = new Set(boards.map((b) => b.id));

  const toAdd = boards.filter((b) => !existingBoardIds.has(b.id));
  const toRemove = existing.filter(
    (item) =>
      item.column_values[0]?.text &&
      !liveBoardIds.has(item.column_values[0].text)
  );
  const toUpdate = existing.filter(
    (item) =>
      item.column_values[0]?.text &&
      liveBoardIds.has(item.column_values[0].text)
  );

  console.log(`3. Resumen de cambios:`);
  console.log(`   - Nuevos por agregar: ${toAdd.length}`);
  console.log(`   - Obsoletos por eliminar: ${toRemove.length}`);
  console.log(`   - Existentes (se actualizan URLs): ${toUpdate.length}\n`);

  if (DRY_RUN) {
    if (toAdd.length > 0) {
      console.log("   Tableros nuevos:");
      toAdd.slice(0, 10).forEach((b) => console.log(`     + ${b.name} (${b.id})`));
      if (toAdd.length > 10) console.log(`     ... y ${toAdd.length - 10} más`);
    }
    if (toRemove.length > 0) {
      console.log("   Ítems obsoletos:");
      toRemove.slice(0, 5).forEach((item) =>
        console.log(`     - ID item: ${item.id} (board: ${item.column_values[0]?.text})`)
      );
    }
    console.log("\nDry-run finalizado. Ejecuta sin DRY_RUN para aplicar.");
    return;
  }

  if (toRemove.length > 0) {
    console.log("4. Eliminando tableros obsoletos...");
    await deleteItems(toRemove.map((item) => item.id));
    console.log("   Hecho.\n");
  }

  if (toUpdate.length > 0) {
    console.log("5. Actualizando URLs en ítems existentes...");
    const batchSize = 5;
    let updated = 0;
    for (let i = 0; i < toUpdate.length; i += batchSize) {
      const batch = toUpdate.slice(i, i + batchSize);
      const mutations = batch
        .map((item, idx) => {
          const boardId = item.column_values[0]?.text;
          const boardUrl = `https://${ACCOUNT_SLUG}.monday.com/boards/${boardId}`;
          const colValue = JSON.stringify({
            [COLUMN_IDS.url]: { url: boardUrl, text: "Abrir" },
          }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          return `u${idx}: change_multiple_column_values(item_id: ${item.id}, board_id: ${DIRECTORY_BOARD_ID}, column_values: "${colValue}") { id }`;
        })
        .join("\n");
      await mondayApi(`mutation { ${mutations} }`);
      updated += batch.length;
      console.log(`   Actualizados ${updated}/${toUpdate.length}`);
      await sleep(500);
    }
    console.log("   Hecho.\n");
  }

  if (toAdd.length > 0) {
    console.log("6. Agregando tableros nuevos...");
    await createItems(toAdd);
    console.log("   Hecho.\n");
  }

  console.log("=== Sincronización completada ===");
  console.log(`   Tableros en directorio: ${toUpdate.length + toAdd.length}`);
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});
