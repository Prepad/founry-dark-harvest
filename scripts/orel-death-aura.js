// Orel Death Aura
// Foundry VTT v13 + dnd5e
// Requires SocketLib
// Logs start with "Orel: "

const OREL_PREFIX = "Orel: ";
const SOCKET_FN = "orelDeathAura_showWizardDialog_v1";
const SOCKET_FN_APPLY_HEAL = "orelDeathAura_applyHeal_v1";
const SOCKET_FN_CONSUME_USE = "orelDeathAura_consumeUse_v1";

let OREL_SOCKET = null;

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
  radiusProgression: "radiusProgression",
  healDiceProgression: "healDiceProgression",
  maxRestoreSlotLevelProgression: "maxRestoreSlotLevelProgression",
  usageFeature: "usageFeature"
};

// Presets for UI pickers
const PRESETS = {
  radius: [
    { key: "30-flat", label: "30 ft (all levels)", value: Array.from({ length: 20 }, () => 30) },
    { key: "10to30", label: "10→30 ft (every 5 levels +5)", value: [10,10,10,10,10,15,15,15,15,15,20,20,20,20,20,25,25,25,25,25] },
    { key: "20to60", label: "20→60 ft (every 4 levels +10)", value: [20,20,20,20,30,30,30,30,40,40,40,40,50,50,50,50,60,60,60,60] }
  ],
  healDice: [
    { key: "1d6-flat", label: "1d6 (all levels)", value: Array.from({ length: 20 }, () => "1d6") },
    { key: "d6-scaling", label: "1d6→4d6 (lvl 1/5/11/17)", value: ["1d6","1d6","1d6","1d6","2d6","2d6","2d6","2d6","2d6","2d6","3d6","3d6","3d6","3d6","3d6","3d6","4d6","4d6","4d6","4d6"] },
    { key: "d8-scaling", label: "1d8→4d8 (lvl 1/5/11/17)", value: ["1d8","1d8","1d8","1d8","2d8","2d8","2d8","2d8","2d8","2d8","3d8","3d8","3d8","3d8","3d8","3d8","4d8","4d8","4d8","4d8"] },
    { key: "pb-d6", label: "PB d6 (approx)", value: ["2d6","2d6","2d6","2d6","3d6","3d6","3d6","3d6","4d6","4d6","4d6","4d6","5d6","5d6","5d6","5d6","6d6","6d6","6d6","6d6"] }
  ],
  maxRestore: [
    { key: "cap9", label: "Cap 9", value: Array.from({ length: 20 }, () => 9) },
    { key: "cap3", label: "Cap 3", value: Array.from({ length: 20 }, () => 3) },
    { key: "cap5", label: "Cap 5", value: Array.from({ length: 20 }, () => 5) }
  ]
};

function parseNumberProgression(jsonText, { length = 20, fallbackValue = 30, min = null, max = null } = {}) {
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
    warn("parseNumberProgression: invalid JSON, using fallback", { error: String(e) });
    return Array.from({ length }, () => fallbackValue);
  }
}

function parseStringProgression(jsonText, { length = 20, fallbackValue = "1d6" } = {}) {
  try {
    const arr = JSON.parse(jsonText);
    if (!Array.isArray(arr)) throw new Error("Not an array");
    const out = [];
    for (let i = 0; i < length; i++) {
      let v = String(arr[i] ?? fallbackValue);
      if (!v.trim()) v = fallbackValue;
      out.push(v);
    }
    return out;
  } catch (e) {
    warn("parseStringProgression: invalid JSON, using fallback", { error: String(e) });
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
  } catch (e) {}
  return game.actors.get(v) ?? null;
}

async function getWizardActor() {
  return await resolveActorIdOrUuid(game.settings.get("orel-death-aura", SETTINGS.wizardActor));
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

// ---- Usage feature (passive like Wild Shape), embedded Item on wizard actor ----
async function findUsageFeature(wizardActor) {
  const ref = (game.settings.get("orel-death-aura", SETTINGS.usageFeature) ?? "").trim();
  if (!ref) return null;

  try {
    if (ref.includes(".")) {
      const doc = await fromUuid(ref);
      if (doc?.documentName === "Item" && (doc.parent?.id === wizardActor.id || doc.actor?.id === wizardActor.id)) return doc;
    }
  } catch (e) {}

  return wizardActor.items.get(ref)
    ?? wizardActor.items.find(i => (i.name ?? "").toLowerCase() === ref.toLowerCase())
    ?? null;
}

function getItemUses(item) {
  const uses = foundry.utils.getProperty(item, "system.uses");
  const value = Number(uses?.value ?? 0);
  const max = Number(uses?.max ?? 0);
  return { value, max, hasUses: max > 0 };
}

// ---- Actions ----
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

// ------------------ GM-side handlers (SocketLib) ------------------

// Payload:
// { targetActorUuid: string, amount: number }
async function gmApplyHeal(payload) {
  try {
    log("gmApplyHeal: received", payload);
    if (!game.user.isGM) return false;

    const { targetActorUuid, amount } = payload ?? {};
    if (!targetActorUuid || !Number.isFinite(amount) || amount <= 0) {
      warn("gmApplyHeal: invalid payload", payload);
      return false;
    }

    const targetActor = await fromUuid(targetActorUuid);
    if (!targetActor) {
      warn("gmApplyHeal: target actor not found", payload);
      return false;
    }

    const hp = targetActor.system.attributes.hp;
    const newValue = Math.min((hp.value ?? 0) + amount, hp.max ?? (hp.value ?? 0));
    await targetActor.update({ "system.attributes.hp.value": newValue });

    log("gmApplyHeal: applied", { target: targetActor.name, amount, newValue, max: hp.max });
    return true;
  } catch (e) {
    warn("gmApplyHeal error", e);
    return false;
  }
}

// Payload:
// { wizardActorUuid: string, featureItemId: string }
async function gmConsumeUse(payload) {
  try {
    log("gmConsumeUse: received", payload);
    if (!game.user.isGM) return false;

    const { wizardTokenUuid, wizardActorUuid, featureItemId } = payload ?? {};
    if (!featureItemId) {
      warn("gmConsumeUse: invalid payload", payload);
      return false;
    }

    // 1) Prefer token actor (works for linked + unlinked)
    let wizardActor = null;

    if (wizardTokenUuid) {
      const tokenDoc = await fromUuid(wizardTokenUuid);
      wizardActor = tokenDoc?.actor ?? null;
      if (!wizardActor) warn("gmConsumeUse: token actor not found", { wizardTokenUuid });
    }

    // 2) Fallback to world actor
    if (!wizardActor && wizardActorUuid) {
      wizardActor = await fromUuid(wizardActorUuid);
      if (!wizardActor) warn("gmConsumeUse: wizard actor not found", { wizardActorUuid });
    }

    if (!wizardActor) {
      warn("gmConsumeUse: no wizard actor resolved", payload);
      return false;
    }

    const feature = wizardActor.items.get(featureItemId);
    if (!feature) {
      warn("gmConsumeUse: feature item not found on resolved actor", {
        actor: wizardActor.name,
        actorUuid: wizardActor.uuid,
        featureItemId
      });
      return false;
    }

    const uses = foundry.utils.getProperty(feature, "system.uses");
    const value = Number(uses?.value ?? 0);
    const max = Number(uses?.max ?? 0);
    const hasUses = max > 0;

    if (!hasUses) return true;
    if (value <= 0) return false;

    await feature.update({ "system.uses.value": value - 1 });
    log("gmConsumeUse: decremented", { actor: wizardActor.name, feature: feature.name, from: value, to: value - 1, max });
    return true;
  } catch (e) {
    warn("gmConsumeUse error", e);
    return false;
  }
}

// ------------------ Dialogs ------------------

async function dialogMainChoice(deadName, radiusFt, usesInfo) {
  log("dialogMainChoice", { deadName, radiusFt, usesInfo });

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

async function dialogPickHealTarget(wizardToken, wizardActor, { radiusFt }) {
  const candidates = canvas.tokens.placeables
    .filter(t => t?.actor)
    .filter(t => (actorHasNonGmOwner(t.actor) || t.actor.id === wizardActor.id))
    .filter(t => distFt(wizardToken, t) <= radiusFt);

  log("dialogPickHealTarget", { radiusFt, candidates: candidates.map(t => t.name) });

  if (!candidates.length) {
    ui.notifications.warn("Нет токенов игроков в радиусе для исцеления.");
    return null;
  }

  const optionsTargets = candidates
    .map(t => `<option value="${t.id}">${t.name} — ${t.actor?.name}</option>`)
    .join("");

  const content = `
    <p>Выбери цель в пределах ${radiusFt} ft.</p>
    <div style="margin-top:8px;">
      <label>Цель:</label>
      <select id="targetTokenId">${optionsTargets}</select>
    </div>
  `;

  return await new Promise(resolve => {
    new Dialog({
      title: "Исцеление — цель",
      content,
      buttons: {
        ok: { icon: '<i class="fas fa-check"></i>', label: "Бросить кубы", callback: html => resolve(String(html.find("#targetTokenId").val())) },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Отмена", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

async function dialogRestoreLevel(wizardActor, { capLevel }) {
  log("dialogRestoreLevel", { capLevel });

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

// ------------------ Socket handler (wizard owner client) ------------------

async function orelShowWizardDialog(payload) {
  try {
    log("socket: orelShowWizardDialog received", payload);

    const wizardActor = await getWizardActor();
    if (!wizardActor || wizardActor.id !== payload.wizardActorId) return;

    // Show ONLY on owner client (GM excluded)
    const isOwner = wizardActor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!isOwner || game.user.isGM) return;

    const wizardToken = getActiveTokenForActor(wizardActor);
    if (!wizardToken) return;

    const level = getActorLevel(wizardActor);

    const radiusArr = parseNumberProgression(game.settings.get("orel-death-aura", SETTINGS.radiusProgression), { fallbackValue: 30, min: 0 });
    const healDiceArr = parseStringProgression(game.settings.get("orel-death-aura", SETTINGS.healDiceProgression), { fallbackValue: "1d6" });
    const maxRestoreArr = parseNumberProgression(game.settings.get("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression), { fallbackValue: 9, min: 1, max: 9 });

    const radiusFt = radiusArr[level - 1] ?? 30;
    const healFormula = healDiceArr[level - 1] ?? "1d6";
    const capRestore = maxRestoreArr[level - 1] ?? 9;

    const maxSlot = getMaxSpellLevelWithSlots(wizardActor);
    const capRestoreFinal = Math.min(capRestore, maxSlot || 9);

    const usageFeature = await findUsageFeature(wizardActor);
    const usesInfo = usageFeature ? getItemUses(usageFeature) : null;

    // Early client-side guard (real decrement will be done by GM)
    if (usesInfo?.hasUses && usesInfo.value <= 0) {
      ui.notifications.warn("Использования пассивки закончились.");
      return;
    }

    const choice = await dialogMainChoice(payload.deadName ?? "существо", radiusFt, usesInfo);
    if (!choice) return;

    if (!OREL_SOCKET) {
      ui.notifications.error("Orel: socket не готов.");
      return;
    }

    if (choice === "restore") {
      const lvl = await dialogRestoreLevel(wizardActor, { capLevel: capRestoreFinal });
      if (!lvl) return;

      // Consume use as GM (only when applying)
      if (usageFeature) {
        const ok = await OREL_SOCKET.executeAsGM(SOCKET_FN_CONSUME_USE, {
          wizardTokenUuid: wizardToken.document.uuid,
          wizardActorUuid: wizardActor.uuid,
          featureItemId: usageFeature.id
        });
        if (!ok) return ui.notifications.warn("Использования пассивки закончились.");
      }

      await restoreSlot(wizardActor, lvl);
      return;
    }

    if (choice === "heal") {
      // Step 1: pick target
      const targetTokenId = await dialogPickHealTarget(wizardToken, wizardActor, { radiusFt });
      if (!targetTokenId) return;

      const targetToken = canvas.tokens.get(targetTokenId);
      if (!targetToken?.actor) return;

      // Re-check range
      const d = distFt(wizardToken, targetToken);
      if (d > radiusFt) return ui.notifications.warn(`Цель уже вне радиуса ${radiusFt} ft.`);

      // Consume use as GM (only when applying)
      if (usageFeature) {
        const ok = await OREL_SOCKET.executeAsGM(SOCKET_FN_CONSUME_USE, {
          wizardTokenUuid: wizardToken.document.uuid,
          wizardActorUuid: wizardActor.uuid,
          featureItemId: usageFeature.id
        });
        if (!ok) return ui.notifications.warn("Использования пассивки закончились.");
      }

      // Step 2: roll dice (client) + apply heal (GM)
      log("heal: rolling dice", { healFormula, level, target: targetToken.name });

      const roll = await (new Roll(healFormula)).evaluate({ async: true });
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ token: wizardToken }),
        flavor: `Orel Death Aura — исцеление (${healFormula}) для ${targetToken.name}`
      });

      const amount = Number(roll.total ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        ui.notifications.info("Лечение не дало положительного результата.");
        return;
      }

      await OREL_SOCKET.executeAsGM(SOCKET_FN_APPLY_HEAL, {
        targetActorUuid: targetToken.actor.uuid,
        amount
      });

      return;
    }
  } catch (e) {
    warn("socket handler error", e);
  }
}

// ------------------ Settings UI ------------------

class OrelDeathAuraConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "orel-death-aura-config",
      title: "Orel Death Aura — Configure",
      template: "modules/orel-death-aura/templates/config.hbs",
      width: 680,
      height: "auto",
      closeOnSubmit: true,
      submitOnChange: false,
      resizable: true
    });
  }

  async getData() {
    const wizardRef = game.settings.get("orel-death-aura", SETTINGS.wizardActor) ?? "";
    const usageRef = game.settings.get("orel-death-aura", SETTINGS.usageFeature) ?? "";

    const actors = game.actors.contents
      .filter(a => a.type === "character")
      .map(a => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const wizardActor = game.actors.get(wizardRef) ?? null;

    // Features: feats with Uses configured
    const features = wizardActor
      ? wizardActor.items
          .filter(i => {
            const max = Number(foundry.utils.getProperty(i, "system.uses.max") ?? 0);
            if (max <= 0) return false;
            const t = (i.type ?? "").toLowerCase();
            return ["feat"].includes(t);
          })
          .map(i => ({
            id: i.id,
            name: `${i.name} (${foundry.utils.getProperty(i, "system.uses.value") ?? 0}/${foundry.utils.getProperty(i, "system.uses.max") ?? 0})`
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    return {
      wizardRef,
      usageRef,
      actors,
      features,
      radiusProg: game.settings.get("orel-death-aura", SETTINGS.radiusProgression),
      healDiceProg: game.settings.get("orel-death-aura", SETTINGS.healDiceProgression),
      maxRestore: game.settings.get("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression),
      radiusPresets: PRESETS.radius.map(p => ({ key: p.key, label: p.label })),
      healDicePresets: PRESETS.healDice.map(p => ({ key: p.key, label: p.label })),
      maxRestorePresets: PRESETS.maxRestore.map(p => ({ key: p.key, label: p.label }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('select[name="radiusPreset"]').on("change", ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      const preset = PRESETS.radius.find(p => p.key === key);
      if (preset) html.find('textarea[name="radiusProgression"]').val(JSON.stringify(preset.value));
      ev.currentTarget.value = "";
    });

    html.find('select[name="healDicePreset"]').on("change", ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      const preset = PRESETS.healDice.find(p => p.key === key);
      if (preset) html.find('textarea[name="healDiceProgression"]').val(JSON.stringify(preset.value));
      ev.currentTarget.value = "";
    });

    html.find('select[name="maxRestorePreset"]').on("change", ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      const preset = PRESETS.maxRestore.find(p => p.key === key);
      if (preset) html.find('textarea[name="maxRestoreSlotLevelProgression"]').val(JSON.stringify(preset.value));
      ev.currentTarget.value = "";
    });

    html.find('select[name="wizardActor"]').on("change", () => {
      ui.notifications.info("Сохрани настройки и открой конфиг заново, чтобы обновить список особенностей.");
    });
  }

  async _updateObject(event, formData) {
    await game.settings.set("orel-death-aura", SETTINGS.wizardActor, String(formData.wizardActor ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.usageFeature, String(formData.usageFeature ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.radiusProgression, String(formData.radiusProgression ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.healDiceProgression, String(formData.healDiceProgression ?? ""));
    await game.settings.set("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression, String(formData.maxRestoreSlotLevelProgression ?? ""));
    ui.notifications.info("Orel: настройки сохранены.");
  }
}

// ------------------ Init & Ready ------------------

Hooks.once("init", () => {
  if (!Handlebars.helpers.eq) Handlebars.registerHelper("eq", (a, b) => a === b);

  game.settings.register("orel-death-aura", SETTINGS.wizardActor, {
    name: "Wizard Actor",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register("orel-death-aura", SETTINGS.usageFeature, {
    name: "Usage Feature",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register("orel-death-aura", SETTINGS.radiusProgression, {
    name: "Radius progression",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => 30))
  });

  game.settings.register("orel-death-aura", SETTINGS.healDiceProgression, {
    name: "Heal dice progression",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => "1d6"))
  });

  game.settings.register("orel-death-aura", SETTINGS.maxRestoreSlotLevelProgression, {
    name: "Max restore slot progression",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(Array.from({ length: 20 }, () => 9))
  });

  game.settings.registerMenu("orel-death-aura", "configMenu", {
    name: "Orel Death Aura — Configure",
    label: "Open Config",
    hint: "Выбор волшебника, радиуса, кубов лечения и расходуемой пассивной особенности.",
    icon: "fas fa-hat-wizard",
    type: OrelDeathAuraConfig,
    restricted: true
  });
});

Hooks.once("ready", async () => {
  log("ready: start");

  if (!game.modules.get("socketlib")?.active || !globalThis.socketlib) {
    ui.notifications.error("Orel: нужен модуль SocketLib (включи его) для работы Orel Death Aura.");
    warn("SocketLib inactive");
    return;
  }

  // Register socket handlers on ALL clients
  OREL_SOCKET = socketlib.registerSystem(game.system.id);
  OREL_SOCKET.register(SOCKET_FN, orelShowWizardDialog);
  OREL_SOCKET.register(SOCKET_FN_APPLY_HEAL, gmApplyHeal);
  OREL_SOCKET.register(SOCKET_FN_CONSUME_USE, gmConsumeUse);

  log("ready: socket handlers registered", {
    system: game.system.id,
    SOCKET_FN,
    SOCKET_FN_APPLY_HEAL,
    SOCKET_FN_CONSUME_USE
  });

  // GM-only death detector
  if (!game.user.isGM) {
    log("ready: non-GM client; death detector disabled");
    return;
  }

  const lastDeath = new Map();
  const DEATH_DEDUP_MS = 1200;

  function shouldProcessDeath(deadActorId) {
    const now = Date.now();
    const prev = lastDeath.get(deadActorId) ?? 0;
    lastDeath.set(deadActorId, now);
    return (now - prev) > DEATH_DEDUP_MS;
  }

  Hooks.on("preUpdateActor", async (deadActor, changes) => {
    try {
      const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
      if (newHp === undefined || newHp === null) return;

      const oldHp = deadActor.system.attributes.hp.value ?? 0;
      if (!(oldHp > 0 && Number(newHp) <= 0)) return;
      if (!shouldProcessDeath(deadActor.id)) return;

      log("GM detector: death transition", { dead: deadActor.name, oldHp, newHp });

      const wizardActor = await getWizardActor();
      if (!wizardActor) return;

      const wizardToken = getActiveTokenForActor(wizardActor);
      const deadToken = getActiveTokenForActor(deadActor);
      if (!wizardToken || !deadToken) return;

      const level = getActorLevel(wizardActor);
      const radiusArr = parseNumberProgression(game.settings.get("orel-death-aura", SETTINGS.radiusProgression), { fallbackValue: 30, min: 0 });
      const radiusFt = radiusArr[level - 1] ?? 30;

      const dist = distFt(wizardToken, deadToken);
      const inRange = dist <= radiusFt;
      log("GM detector: range check", { dist, radiusFt, inRange });

      if (!inRange) return;

      const ownerIds = getWizardOwnerUserIds(wizardActor);
      if (!ownerIds.length) {
        warn("GM detector: wizard has no non-GM owners; no dialog target");
        return;
      }

      const payload = { wizardActorId: wizardActor.id, deadName: deadActor.name, dist };
      for (const oid of ownerIds) {
        log("GM detector: send socket to owner", { oid, payload });
        await OREL_SOCKET.executeAsUser(SOCKET_FN, oid, payload);
      }
    } catch (e) {
      warn("GM detector error", e);
    }
  });

  ui.notifications.info("Orel: Orel Death Aura активен.");
  log("ready: GM detector enabled");
});
