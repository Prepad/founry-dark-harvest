// Orel Death Aura
// Foundry VTT v13 + dnd5e
// Requires SocketLib
// Logs start with "Orel: "

const OREL_PREFIX = "Orel: ";
const SOCKET_FN = "orelDeathAura_showWizardDialog_v1";

function log(msg, data) {
  if (data !== undefined) console.log(OREL_PREFIX + msg, data);
  else console.log(OREL_PREFIX + msg);
}
function warn(msg, data) {
  if (data !== undefined) console.warn(OREL_PREFIX + msg, data);
  else console.warn(OREL_PREFIX + msg);
}

const SETTINGS = {
  wizardActor: "wizardActor",
  healMultiplierProgression: "healMultiplierProgression",
  maxHealSpellLevelProgression: "maxHealSpellLevelProgression",
  maxRestoreSlotLevelProgression: "maxRestoreSlotLevelProgression",
  radiusProgression: "radiusProgression",
  usageItem: "usageItem", // Item UUID/ID within actor, or name (fallback)
};

function parseProgression(jsonText, { length = 20, fallbackValue = 30, min = null, max = null } = {}) {
  try {
    const arr = JSON.parse(jsonText);
    if (!Array.isArray(arr)) throw new Error("Not an array");
    const out = [];
    for (let i = 0; i < length; i++) {
      let v = Number(arr[i] ?? fallbackValue);
      if (Number.isNaN(v)) v = fallbackValue;
      if (min !== null) v = Math.max(min, v);
      if (max !== null) v = Math.min(max, v);
      out.push(v);
    }
    return out;
  } catch (e) {
    warn("parseProgression: invalid JSON, using fallback", { jsonText, error: String(e) });
    return Array.from({ length }, () => fallbackValue);
  }
}

async function resolveActorIdOrUuid(idOrUuid) {
  const v = (idOrUuid ?? "").trim();
  if (!v) return null;
  try {
    if (v.includes(".")) {
      const doc = await fromUuid(v);
      if (doc?.documentName === "Actor") return doc;
      if (doc?.actor) return doc.actor;
    }
  } catch (e) {
    // ignore
  }
  return game.actors.get(v) ?? null;
}

async function getWizardActor() {
  const idOrUuid = game.settings.get("orel-death-aura", SETTINGS.wizardActor)?.trim();
  return await resolveActorIdOrUuid(idOrUuid);
}

function getActiveTokenForActor(actor) {
  return actor?.getActiveTokens?.()[0] ?? canvas.tokens.placeables.find(t => t.actor?.id === actor?.id) ?? null;
}

function distFt(t1, t2) {
  if (!t1 || !t2) return Infinity;
  return canvas.grid.measureDistance(t1.center, t2.center);
}

function getActorLevel(actor) {
  const lvl = Number(foundry.utils.getProperty(actor, "system.details.level") ?? 1);
  return Math.max(1, Math.min(20, Number.isFinite(lvl) ? lvl : 1));
}

function actorHasNonGmOwner(actor) {
  return game.users?.some(u => !u.isGM && actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

function getWizardOwnerUserIds(wizardActor) {
  return game.users
    .filter(u => !u.isGM)
    .filter(u => wizardActor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))
    .map(u => u.id);
}

function getMaxSpellLevelWithSlots(actor) {
  for (let l = 9; l >= 1; l--) {
    const max = foundry.utils.getProperty(actor, `system.spells.spell${l}.max`) ?? 0;
    if (max > 0) return l;
  }
  return 0;
}

function buildSpellLevelOptions(actor, { capLevel = 9 } = {}) {
  const options = [];
  for (let l = 1; l <= 9; l++) {
    const cur = foundry.utils.getProperty(actor, `system.spells.spell${l}.value`) ?? 0;
    const max = foundry.utils.getProperty(actor, `system.spells.spell${l}.max`) ?? 0;
    const disabled = (max <= 0) || (l > capLevel);
    options.push(`<option value="${l}" ${disabled ? "disabled" : ""}>${l} уровень (${cur}/${max})</option>`);
  }
  return options.join("");
}

async function findUsageItem(wizardActor) {
  const ref = (game.settings.get("orel-death-aura", SETTINGS.usageItem) ?? "").trim();
  if (!ref) return null;

  // Try UUID first
  try {
    if (ref.includes(".")) {
      const doc = await fromUuid(ref);
      if (doc?.documentName === "Item" && doc.parent?.id === wizardActor.id) return doc;
      if (doc?.documentName === "Item" && doc.actor?.id === wizardActor.id) return doc;
    }
  } catch (e) {
    // ignore
  }

  // Try item ID on actor
  const byId = wizardActor.items.get(ref);
  if (byId) return byId;

  // Fallback: by name
  const byName = wizardActor.items.find(i => (i.name ?? "").toLowerCase() === ref.toLowerCase());
  return byName ?? null;
}

function getItemUses(item) {
  const uses = foundry.utils.getProperty(item, "system.uses");
  const value = Number(uses?.value ?? 0);
  const max = Number(uses?.max ?? 0);
  return { value, max, hasUses: max > 0 };
}

async function consumeOneUse(item) {
  const { value, max, hasUses } = getItemUses(item);
  if (!hasUses) return true; // unlimited / not configured
  if (value <= 0) return false;
  await item.update({ "system.uses.value": value - 1 });
  return true;
}

async function restoreSlot(actor, level) {
  log("restoreSlot: attempt", { actor: actor.name, level });
  const path = `system.spells.spell${level}.value`;
  const maxPath = `system.spells.spell${level}.max`;
  const cur = foundry.utils.getProperty(actor, path) ?? 0;
  const max = foundry.utils.getProperty(actor, maxPath) ?? 0;

  if (max <= 0) return ui.notifications.warn(`У ${actor.name} нет ячеек ${level} уровня.`);
  if (cur >= max) return ui.notifications.info(`Ячейки ${level} уровня уже полные (${cur}/${max}).`);

  await actor.update({ [path]: cur + 1 });
  ui.notifications.info(`${actor.name} восстановил(а) 1 ячейку ${level} уровня (${cur + 1}/${max}).`);
  log("restoreSlot: done", { newValue: cur + 1, max });
}

async function healActor(targetActor, amount) {
  log("healActor: attempt", { target: targetActor.name, amount });
  const hp = targetActor.system.attributes.hp;
  const newValue = Math.min((hp.value ?? 0) + amount, hp.max ?? (hp.value ?? 0));
  await targetActor.update({ "system.attributes.hp.value": newValue });
  ui.notifications.info(`${targetActor.name} исцелён(а) на ${amount} HP (${newValue}/${hp.max}).`);
  log("healActor: done", { newValue, max: hp.max });
}

// ------------------ Dialogs (run on wizard owner client) ------------------

async function dialogMainChoice(deadName, radiusFt, usesInfo) {
  log("Dialog #1: main choice", { deadName, radiusFt, usesInfo });

  const usesLine = usesInfo?.hasUses
    ? `<p style="opacity:.8; margin-top:4px;">Использования: ${usesInfo.value}/${usesInfo.max}</p>`
    : "";

  const content = `
    <p><b>Пассивка:</b> существо (${deadName}) умерло в пределах ${radiusFt} ft.</p>
    ${usesLine}
  `;
  return await new Promise(resolve => {
    new Dialog({
      title: "Пассивка волшебника",
      content,
      buttons: {
        heal: { icon: '<i class="fas fa-heart"></i>', label: "Исцелить", callback: () => resolve("heal") },
        restore: { icon: '<i class="fas fa-magic"></i>', label: "Восстановить ячейку", callback: () => resolve("restore") },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Отмена", callback: () => resolve(null) }
      },
      default: "heal",
      close: () => resolve(null)
    }).render(true);
  });
}

async function dialogRestoreLevel(wizardActor, { capLevel }) {
  log("Dialog: restore level", { capLevel });
  const slotOptions = buildSpellLevelOptions(wizardActor, { capLevel });

  const content = `
    <p>Выбери уровень ячейки, которую нужно восстановить (+1).</p>
    <div style="margin-top:8px;">
      <label>Уровень:</label>
      <select id="spellLevel">${slotOptions}</select>
    </div>
  `;

  return await new Promise(resolve => {
    new Dialog({
      title: "Восстановление ячейки",
      content,
      buttons: {
        ok: { icon: '<i class="fas fa-check"></i>', label: "Восстановить", callback: html => resolve(Number(html.find("#spellLevel").val())) },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Отмена", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

async function dialogHealTargetAndLevel(wizardToken, wizardActor, { radiusFt, capSpellLevel, multiplier }) {
  const candidates = canvas.tokens.placeables
    .filter(t => t?.actor)
    .filter(t => (actorHasNonGmOwner(t.actor) || t.actor.id === wizardActor.id))
    .filter(t => distFt(wizardToken, t) <= radiusFt);

  log("Dialog #2: heal candidates", {
    count: candidates.length,
    names: candidates.map(t => t.name),
    capSpellLevel,
    multiplier
  });

  if (!candidates.length) {
    ui.notifications.warn("Нет токенов игроков в радиусе для исцеления.");
    return null;
  }

  const optionsTargets = candidates
    .map(t => `<option value="${t.id}">${t.name} — ${t.actor?.name}</option>`)
    .join("");

  const slotOptions = buildSpellLevelOptions(wizardActor, { capLevel: capSpellLevel });

  const content = `
    <p>Выбери цель в пределах ${radiusFt} ft и уровень:</p>
    <p style="opacity:.8; margin-top:4px;">Лечение = уровень × ${multiplier}</p>
    <div style="display:flex; flex-direction:column; gap:10px; margin-top:8px;">
      <div>
        <label>Цель:</label>
        <select id="targetTokenId">${optionsTargets}</select>
      </div>
      <div>
        <label>Уровень:</label>
        <select id="spellLevel">${slotOptions}</select>
      </div>
    </div>
  `;

  return await new Promise(resolve => {
    new Dialog({
      title: "Исцеление",
      content,
      buttons: {
        ok: {
          icon: '<i class="fas fa-check"></i>',
          label: "Исцелить",
          callback: html => resolve({
            tokenId: String(html.find("#targetTokenId").val()),
            level: Number(html.find("#spellLevel").val())
          })
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Отмена", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

// ------------------ Socket handler (runs on wizard owner client) ------------------

async function orelShowWizardDialog(payload) {
  try {
    log("socket: received", payload);

    const wizardActor = await getWizardActor();
    if (!wizardActor) return warn("socket: wizard actor not configured / not found");
    if (wizardActor.id !== payload.wizardActorId) return;

    // Show ONLY on owner client (GM excluded)
    const isOwner = wizardActor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!isOwner || game.user.isGM) {
      log("socket: not eligible on this client", { user: game.user.id, isGM: game.user.isGM, isOwner });
      return;
    }

    // Progressions
    const level = getActorLevel(wizardActor);

    const healMultArr = parseProgression(game.settings.get("orel-death-aura", SETTINGS.healMultiplierProgression), { fallbackValue: 3, min: 0 });
    const maxHealArr = parseProgression(game.settings.get("orel-death-aura", SETTINGS.maxHealSpellLevelProgression), { fallbackValue: 9, min: 1, max: 9 });
    const maxRestoreArr = parseProgression(game.settings.get("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression), { fallbackValue: 9, min: 1, max: 9 });
    const radiusArr = parseProgression(game.settings.get("orel-death-aura", SETTINGS.radiusProgression), { fallbackValue: 30, min: 0 });

    const multiplier = healMultArr[level - 1] ?? 3;
    const capHeal = maxHealArr[level - 1] ?? 9;
    const capRestore = maxRestoreArr[level - 1] ?? 9;
    const radiusFt = radiusArr[level - 1] ?? 30;

    const wizardToken = getActiveTokenForActor(wizardActor);
    if (!wizardToken) return warn("socket: wizard token not found on scene");

    // Usage limitation
    const usageItem = await findUsageItem(wizardActor);
    const usesInfo = usageItem ? getItemUses(usageItem) : null;

    if (usesInfo?.hasUses && usesInfo.value <= 0) {
      ui.notifications.warn("Использования пассивки закончились.");
      log("socket: no uses left", { item: usageItem?.name, usesInfo });
      return;
    }

    // Cap levels to available slots + progression caps
    const maxSlot = getMaxSpellLevelWithSlots(wizardActor);
    const capHealFinal = Math.min(capHeal, maxSlot || 9);
    const capRestoreFinal = Math.min(capRestore, maxSlot || 9);

    const choice = await dialogMainChoice(payload.deadName ?? "существо", radiusFt, usesInfo);
    log("socket: choice", { choice });
    if (!choice) return;

    // Consume use only if an effect is actually applied
    if (choice === "restore") {
      const lvl = await dialogRestoreLevel(wizardActor, { capLevel: capRestoreFinal });
      log("socket: restore level selected", { lvl });
      if (!lvl) return;

      if (usageItem) {
        const ok = await consumeOneUse(usageItem);
        if (!ok) {
          ui.notifications.warn("Использования пассивки закончились.");
          log("socket: failed to consume use", { item: usageItem.name });
          return;
        }
      }

      await restoreSlot(wizardActor, lvl);
      return;
    }

    if (choice === "heal") {
      const pick = await dialogHealTargetAndLevel(wizardToken, wizardActor, {
        radiusFt,
        capSpellLevel: capHealFinal,
        multiplier
      });
      log("socket: heal pick", pick);
      if (!pick) return;

      const targetToken = canvas.tokens.get(pick.tokenId);
      if (!targetToken?.actor) return warn("socket: target token/actor not found", pick);

      // Re-check range
      const d = distFt(wizardToken, targetToken);
      if (d > radiusFt) {
        ui.notifications.warn(`Цель уже вне радиуса ${radiusFt} ft.`);
        log("socket: target out of range at apply time", { d, radiusFt });
        return;
      }

      if (usageItem) {
        const ok = await consumeOneUse(usageItem);
        if (!ok) {
          ui.notifications.warn("Использования пассивки закончились.");
          log("socket: failed to consume use", { item: usageItem.name });
          return;
        }
      }

      await healActor(targetToken.actor, pick.level * multiplier);
      return;
    }
  } catch (e) {
    warn("socket: handler error", e);
  }
}

// ------------------ Settings UI (picker) ------------------

class OrelDeathAuraConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "orel-death-aura-config",
      title: "Orel Death Aura — Config",
      template: "modules/orel-death-aura/templates/config.hbs",
      width: 620,
      height: "auto",
      closeOnSubmit: true,
      submitOnChange: false,
      resizable: true
    });
  }

  getData() {
    const wizardRef = game.settings.get("orel-death-aura", SETTINGS.wizardActor) ?? "";
    const usageRef = game.settings.get("orel-death-aura", SETTINGS.usageItem) ?? "";

    const actors = game.actors.contents
      .filter(a => a.type === "character")
      .map(a => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let wizardActor = game.actors.get(wizardRef) ?? null;

    const items = wizardActor
      ? wizardActor.items
          .filter(i => {
            const max = Number(foundry.utils.getProperty(i, "system.uses.max") ?? 0);
            return max > 0; // расходуемые
          })
          .map(i => ({ id: i.id, name: i.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    return {
      wizardRef,
      usageRef,
      actors,
      items,
      healMult: game.settings.get("orel-death-aura", SETTINGS.healMultiplierProgression),
      maxHeal: game.settings.get("orel-death-aura", SETTINGS.maxHealSpellLevelProgression),
      maxRestore: game.settings.get("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression),
      radiusProg: game.settings.get("orel-death-aura", SETTINGS.radiusProgression),
    };
  }

  async _updateObject(event, formData) {
    log("Config save", formData);
    await game.settings.set("orel-death-aura", SETTINGS.wizardActor, String(formData.wizardActor ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.usageItem, String(formData.usageItem ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.radiusProgression, String(formData.radiusProgression ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.healMultiplierProgression, String(formData.healMultiplierProgression ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.maxHealSpellLevelProgression, String(formData.maxHealSpellLevelProgression ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression, String(formData.maxRestoreSlotLevelProgression ?? ""));
    ui.notifications.info("Orel: настройки сохранены.");
  }
}

// ------------------ Initialization ------------------

Hooks.once("init", () => {
  log("init: registering settings");

  if (!Handlebars.helpers.eq) {
    Handlebars.registerHelper("eq", (a, b) => a === b);
  }

  // Hidden base settings (managed via UI menu)
  game.settings.register("orel-death-aura", SETTINGS.wizardActor, {
    name: "Wizard Actor UUID/ID",
    hint: "Используй меню настройки модуля.",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register("orel-death-aura", SETTINGS.usageItem, {
    name: "Usage Item (UUID/ID/Name)",
    hint: "Используй меню настройки модуля.",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register("orel-death-aura", SETTINGS.radiusProgression, {
    name: "Radius progression (JSON)",
    hint: "Используй меню настройки модуля.",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => 30))
  });

  game.settings.register("orel-death-aura", SETTINGS.healMultiplierProgression, {
    name: "Heal multiplier progression (JSON)",
    hint: "Используй меню настройки модуля.",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => 3))
  });

  game.settings.register("orel-death-aura", SETTINGS.maxHealSpellLevelProgression, {
    name: "Max heal spell level progression (JSON)",
    hint: "Используй меню настройки модуля.",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => 9))
  });

  game.settings.register("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression, {
    name: "Max restore slot level progression (JSON)",
    hint: "Используй меню настройки модуля.",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => 9))
  });

  // Settings menu with pickers
  game.settings.registerMenu("orel-death-aura", "configMenu", {
    name: "Orel Death Aura — Configure",
    label: "Open Config",
    hint: "Выбор волшебника, радиуса по уровням, прогрессий и расходуемой особенности.",
    icon: "fas fa-hat-wizard",
    type: OrelDeathAuraConfig,
    restricted: true
  });
});

Hooks.once("ready", async () => {
  log("ready: starting");

  if (!game.modules.get("socketlib")?.active || !globalThis.socketlib) {
    ui.notifications.error("Orel: нужен модуль SocketLib (включи его) для работы Orel Death Aura.");
    warn("SocketLib inactive - module disabled");
    return;
  }

  // Register socket handler on EVERY client (module loads for all)
  const socket = socketlib.registerSystem(game.system.id);
  socket.register(SOCKET_FN, orelShowWizardDialog);
  log("SocketLib registered", { system: game.system.id, SOCKET_FN });

  // GM-only death detector to avoid duplicate sends
  if (!game.user.isGM) {
    log("ready: non-GM client - death detector disabled (GM-only)");
    return;
  }

  // Dedup death events
  const lastDeath = new Map(); // actorId -> ts
  const DEATH_DEDUP_MS = 1200;

  function shouldProcessDeath(deadActorId) {
    const now = Date.now();
    const prev = lastDeath.get(deadActorId) ?? 0;
    lastDeath.set(deadActorId, now);
    return (now - prev) > DEATH_DEDUP_MS;
  }

  Hooks.on("preUpdateActor", async (deadActor, changes, options, userId) => {
    try {
      const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
      if (newHp === undefined || newHp === null) return;

      const oldHp = deadActor.system.attributes.hp.value ?? 0;
      log("preUpdateActor: HP update", { dead: deadActor.name, oldHp, newHp, userId });

      if (!(oldHp > 0 && Number(newHp) <= 0)) return;
      if (!shouldProcessDeath(deadActor.id)) return;

      const wizardActor = await getWizardActor();
      if (!wizardActor) return;

      const wizardToken = getActiveTokenForActor(wizardActor);
      const deadToken = getActiveTokenForActor(deadActor);
      if (!wizardToken || !deadToken) return;

      // Use radius progression by wizard level
      const level = getActorLevel(wizardActor);
      const radiusArr = parseProgression(game.settings.get("orel-death-aura", SETTINGS.radiusProgression), { fallbackValue: 30, min: 0 });
      const radiusFt = radiusArr[level - 1] ?? 30;

      const dist = distFt(wizardToken, deadToken);
      const inRange = dist <= radiusFt;
      log("death range check", { dead: deadActor.name, dist, radiusFt, inRange });

      if (!inRange) return;

      const ownerIds = getWizardOwnerUserIds(wizardActor);
      if (!ownerIds.length) return;

      const payload = {
        wizardActorId: wizardActor.id,
        deadName: deadActor.name,
        dist
      };

      for (const oid of ownerIds) {
        log("socket send to owner", { oid, payload });
        await socket.executeAsUser(SOCKET_FN, oid, payload);
      }
    } catch (e) {
      warn("preUpdateActor: handler error", e);
    }
  });

  ui.notifications.info("Orel: Orel Death Aura активен (GM detector).");
  log("GM detector enabled");
});
