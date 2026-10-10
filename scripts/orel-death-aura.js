// Orel Death Aura
// Foundry VTT v13/v14 + dnd5e
// Requires SocketLib
// Logs start with "Orel: "

const OREL_PREFIX = "Orel: ";
const MODULE_ID = "orel-death-aura";
const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SOCKET_FN = "orelDeathAura_showWizardDialog_v1";
const SOCKET_FN_APPLY_HEAL = "orelDeathAura_applyHeal_v2";
const SOCKET_FN_RESTORE_SLOT = "orelDeathAura_restoreSlot_v1";

let OREL_SOCKET = null;
const wizardActions = new Map();

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
  if (!canvas.ready) return null;
  return actor?.getActiveTokens?.()[0] ?? canvas.tokens?.placeables?.find(t => t.actor?.id === actor?.id) ?? null;
}

function distFt(t1, t2) {
  if (!t1 || !t2 || !canvas.ready) return Infinity;
  return canvas.grid.measurePath([t1.center, t2.center]).distance;
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
    .filter(u => u.active && !u.isGM)
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
    const cur = Number(foundry.utils.getProperty(actor, `system.spells.spell${l}.value`) ?? 0);
    const max = Number(foundry.utils.getProperty(actor, `system.spells.spell${l}.max`) ?? 0);
    const disabled = (max <= 0) || (cur >= max) || (l > capLevel);
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
  const rawMax = Number(uses?.max ?? 0);
  const max = Number.isFinite(rawMax) ? Math.max(0, rawMax) : 0;
  // Prefer the modern spent counter; value is a fallback for older Items.
  const rawSpent = Number(uses?.spent ?? (max - Number(uses?.value ?? max)));
  const spent = Number.isFinite(rawSpent) ? Math.max(0, rawSpent) : max;
  const value = Math.max(0, Math.min(max, max - spent));
  return { value, max, spent, hasUses: max > 0 };
}

async function resolveWizardActor(payload) {
  if (payload?.wizardTokenUuid) {
    const tokenDoc = await fromUuid(payload.wizardTokenUuid);
    if (tokenDoc?.actor) return tokenDoc.actor;
  }
  if (payload?.wizardActorUuid) {
    const actor = await fromUuid(payload.wizardActorUuid);
    if (actor?.documentName === "Actor") return actor;
  }
  return null;
}

async function withWizardAction(payload, action) {
  const actor = await resolveWizardActor(payload);
  if (!actor) return { ok: false, message: "Волшебник не найден." };

  // Serialize resource checks, updates and refunds for this actor on the GM.
  const key = actor.uuid;
  const previous = wizardActions.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => action(actor));
  wizardActions.set(key, pending);
  try {
    return await pending;
  } finally {
    if (wizardActions.get(key) === pending) wizardActions.delete(key);
  }
}

async function applyWithFeatureUse(actor, featureItemId, apply) {
  const feature = featureItemId ? actor.items.get(featureItemId) : null;
  if (featureItemId && !feature) {
    return { ok: false, message: "Расходуемая особенность не найдена." };
  }

  const uses = feature ? getItemUses(feature) : null;
  if (uses?.hasUses && uses.value <= 0) {
    return { ok: false, message: "Использования пассивки закончились." };
  }

  let refund = null;
  if (uses?.hasUses) {
    const legacy = feature.system.uses.spent == null && feature.system.uses.value != null;
    const path = legacy ? "system.uses.value" : "system.uses.spent";
    const previous = legacy ? uses.value : uses.spent;
    const next = legacy ? previous - 1 : previous + 1;
    await actor.updateEmbeddedDocuments("Item", [{ _id: feature.id, [path]: next }]);
    refund = () => actor.updateEmbeddedDocuments("Item", [{ _id: feature.id, [path]: previous }]);
  }

  try {
    await apply();
    return { ok: true };
  } catch (error) {
    if (refund) await refund();
    throw error;
  }
}

// ---- Actions ----
async function restoreSlot(actor, level, featureItemId) {
  log("restoreSlot: attempt", { actor: actor.name, level });

  if (!Number.isInteger(level) || level < 1 || level > 9) {
    return { ok: false, message: "Некорректный уровень ячейки." };
  }

  const path = `system.spells.spell${level}.value`;
  const maxPath = `system.spells.spell${level}.max`;
  const cur = Number(foundry.utils.getProperty(actor, path) ?? 0);
  const max = Number(foundry.utils.getProperty(actor, maxPath) ?? 0);

  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) {
    return { ok: false, message: `У ${actor.name} нет ячеек ${level} уровня.` };
  }
  if (cur >= max) {
    return { ok: false, message: `Ячейки ${level} уровня уже полные (${cur}/${max}).` };
  }

  const result = await applyWithFeatureUse(actor, featureItemId, () => actor.update({ [path]: cur + 1 }));
  if (!result.ok) return result;

  log("restoreSlot: done", { newValue: cur + 1, max });
  return { ok: true, message: `${actor.name} восстановил(а) 1 ячейку ${level} уровня (${cur + 1}/${max}).` };
}

// ------------------ GM-side handlers (SocketLib) ------------------

// Payload:
// { wizardTokenUuid: string, featureItemId?: string, targetActorUuid: string, amount: number }
async function gmApplyHeal(payload) {
  try {
    log("gmApplyHeal: received", payload);
    if (!game.user.isGM) return { ok: false };

    const { targetActorUuid, amount } = payload ?? {};
    if (!targetActorUuid || !Number.isFinite(amount) || amount <= 0) {
      warn("gmApplyHeal: invalid payload", payload);
      return { ok: false, message: "Некорректная величина исцеления." };
    }

    return await withWizardAction(payload, async wizardActor => {
      const targetActor = await fromUuid(targetActorUuid);
      const hp = targetActor?.system?.attributes?.hp;
      if (!hp) return { ok: false, message: "Цель исцеления не найдена." };

      const current = Number(hp.value ?? 0);
      const max = Number(hp.effectiveMax ?? hp.max ?? current);
      if (!Number.isFinite(current) || !Number.isFinite(max)) {
        return { ok: false, message: "Некорректные HP цели." };
      }
      const newValue = Math.min(current + amount, max);
      if (newValue <= current) return { ok: false, message: "У цели уже полные HP." };

      const result = await applyWithFeatureUse(wizardActor, payload.featureItemId,
        () => targetActor.update({ "system.attributes.hp.value": newValue }));
      if (result.ok) log("gmApplyHeal: applied", { target: targetActor.name, amount, newValue, max });
      return result;
    });
  } catch (e) {
    warn("gmApplyHeal error", e);
    return { ok: false, message: "Не удалось применить исцеление." };
  }
}

// Payload:
// { wizardTokenUuid: string, featureItemId?: string, level: number }
async function gmRestoreSlot(payload) {
  try {
    if (!game.user.isGM) return { ok: false };
    return await withWizardAction(payload, actor => restoreSlot(actor, payload.level, payload.featureItemId));
  } catch (e) {
    warn("gmRestoreSlot error", e);
    return { ok: false, message: "Не удалось восстановить ячейку." };
  }
}


// ------------------ Dialogs ------------------

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function dialogContent(html) {
  // A DOM div preserves form controls under v14's DialogV2 HTML cleaning.
  const content = document.createElement("div");
  content.innerHTML = html;
  return content;
}

async function dialogMainChoice(deadName, radiusFt, usesInfo) {
  log("dialogMainChoice", { deadName, radiusFt, usesInfo });

  const usesLine = usesInfo?.hasUses
    ? `<p style="opacity:.8; margin-top:4px;">Использования: ${usesInfo.value}/${usesInfo.max}</p>`
    : "";

  const content = `
    <p><b>Пассивка:</b> существо (${escapeHtml(deadName)}) упало до 0 HP в пределах ${radiusFt} ft.</p>
    ${usesLine}
  `;
  return DialogV2.wait({
    window: { title: "Пассивка волшебника" },
    content: dialogContent(content),
    buttons: [
      { action: "heal", icon: "fas fa-heart", label: "Исцелить", default: true },
      { action: "restore", icon: "fas fa-magic", label: "Восстановить ячейку" },
      { action: "cancel", icon: "fas fa-times", label: "Отмена", callback: () => null }
    ],
    rejectClose: false
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
    .map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} — ${escapeHtml(t.actor?.name)}</option>`)
    .join("");

  const content = `
    <p>Выбери цель в пределах ${radiusFt} ft.</p>
    <div style="margin-top:8px;">
      <label>Цель:</label>
      <select name="targetTokenId">${optionsTargets}</select>
    </div>
  `;

  return DialogV2.wait({
    window: { title: "Исцеление — цель" },
    content: dialogContent(content),
    buttons: [
      { action: "ok", icon: "fas fa-check", label: "Бросить кубы", default: true,
        callback: (event, button) => button.form.elements.targetTokenId.value },
      { action: "cancel", icon: "fas fa-times", label: "Отмена", callback: () => null }
    ],
    rejectClose: false
  });
}

async function dialogRestoreLevel(wizardActor, { capLevel }) {
  log("dialogRestoreLevel", { capLevel });

  const hasMissingSlot = Array.from({ length: 9 }, (_, i) => i + 1).some(level => {
    const slot = foundry.utils.getProperty(wizardActor, `system.spells.spell${level}`);
    return level <= capLevel && Number(slot?.max ?? 0) > Number(slot?.value ?? 0);
  });
  if (!hasMissingSlot) {
    ui.notifications.info("Нет ячеек, которые можно восстановить.");
    return null;
  }

  const slotOptions = buildSpellLevelOptions(wizardActor, { capLevel });
  const content = `
    <p>Выбери уровень ячейки, которую нужно восстановить (+1).</p>
    <div style="margin-top:8px;">
      <label>Уровень:</label>
      <select name="spellLevel">${slotOptions}</select>
    </div>
  `;

  return DialogV2.wait({
    window: { title: "Восстановление ячейки" },
    content: dialogContent(content),
    buttons: [
      { action: "ok", icon: "fas fa-check", label: "Восстановить", default: true,
        callback: (event, button) => Number(button.form.elements.spellLevel.value) },
      { action: "cancel", icon: "fas fa-times", label: "Отмена", callback: () => null }
    ],
    rejectClose: false
  });
}

// ------------------ Socket handler (wizard owner client) ------------------

async function orelShowWizardDialog(payload) {
  try {
    log("socket: orelShowWizardDialog received", payload);

    let wizardActor = await getWizardActor();
    if (!wizardActor || wizardActor.id !== payload.wizardActorId) return;

    // Show ONLY on owner client (GM excluded)
    const isOwner = wizardActor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!isOwner || game.user.isGM) return;

    const wizardToken = getActiveTokenForActor(wizardActor);
    if (!wizardToken) return;
    wizardActor = wizardToken.actor ?? wizardActor;

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

      const result = await OREL_SOCKET.executeAsGM(SOCKET_FN_RESTORE_SLOT, {
        wizardTokenUuid: wizardToken.document.uuid,
        featureItemId: usageFeature?.id,
        level: lvl
      });
      if (!result?.ok) ui.notifications.warn(result?.message ?? "Не удалось восстановить ячейку.");
      else ui.notifications.info(result.message);
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

      // Validate the roll before the GM consumes a use and applies healing.
      log("heal: rolling dice", { healFormula, level, target: targetToken.name });

      const roll = await (new foundry.dice.Roll(healFormula)).evaluate();
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: wizardActor, token: wizardToken.document }),
        flavor: `Orel Death Aura — исцеление (${healFormula}) для ${targetToken.name}`
      });

      const amount = Number(roll.total ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        ui.notifications.info("Лечение не дало положительного результата.");
        return;
      }

      const result = await OREL_SOCKET.executeAsGM(SOCKET_FN_APPLY_HEAL, {
        wizardTokenUuid: wizardToken.document.uuid,
        featureItemId: usageFeature?.id,
        targetActorUuid: targetToken.actor.uuid,
        amount
      });
      if (!result?.ok) ui.notifications.warn(result?.message ?? "Не удалось применить исцеление.");

      return;
    }
  } catch (e) {
    warn("socket handler error", e);
    ui.notifications.error("Не удалось применить пассивку. Проверь настройки и повтори попытку.");
  }
}

// ------------------ Settings UI ------------------

class OrelDeathAuraConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "orel-death-aura-config",
    tag: "form",
    window: { title: "Orel Death Aura — Configure", resizable: true },
    position: { width: 680, height: "auto" },
    form: { handler: this.#onSubmitSettings, closeOnSubmit: true, submitOnChange: false }
  };

  static PARTS = {
    config: { template: "modules/orel-death-aura/templates/config.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const wizardRef = game.settings.get("orel-death-aura", SETTINGS.wizardActor) ?? "";
    const usageRef = game.settings.get("orel-death-aura", SETTINGS.usageFeature) ?? "";

    const actors = game.actors.contents
      .filter(a => a.type === "character")
      .map(a => ({ id: a.id, name: a.name, selected: a.id === wizardRef }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const wizardActor = game.actors.get(wizardRef) ?? null;

    // Features: feats with Uses configured
    const features = wizardActor
      ? wizardActor.items
          .filter(i => {
            if (!getItemUses(i).hasUses) return false;
            const t = (i.type ?? "").toLowerCase();
            return ["feat"].includes(t);
          })
          .map(i => {
            const uses = getItemUses(i);
            return { id: i.id, name: `${i.name} (${uses.value}/${uses.max})`, selected: i.id === usageRef };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    return {
      ...context,
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

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.setAttribute("autocomplete", "off");

    for (const [picker, field, presets] of [
      ["radiusPreset", "radiusProgression", PRESETS.radius],
      ["healDicePreset", "healDiceProgression", PRESETS.healDice],
      ["maxRestorePreset", "maxRestoreSlotLevelProgression", PRESETS.maxRestore]
    ]) {
      this.element.querySelector(`select[name="${picker}"]`).addEventListener("change", event => {
        const preset = presets.find(p => p.key === event.currentTarget.value);
        if (preset) this.element.querySelector(`textarea[name="${field}"]`).value = JSON.stringify(preset.value);
        event.currentTarget.value = "";
      });
    }

    this.element.querySelector('select[name="wizardActor"]').addEventListener("change", () => {
      ui.notifications.info("Сохрани настройки и открой конфиг заново, чтобы обновить список особенностей.");
    });
  }

  static async #onSubmitSettings(event, form, formData) {
    await this._saveSettings(formData.object);
  }

  async _saveSettings(formData) {
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

function registerSocketHandlers() {
  if (OREL_SOCKET || !globalThis.socketlib) return;
  OREL_SOCKET = socketlib.registerModule(MODULE_ID);
  if (!OREL_SOCKET) return;
  OREL_SOCKET.register(SOCKET_FN, orelShowWizardDialog);
  OREL_SOCKET.register(SOCKET_FN_APPLY_HEAL, gmApplyHeal);
  OREL_SOCKET.register(SOCKET_FN_RESTORE_SLOT, gmRestoreSlot);
  log("socket handlers registered", { module: MODULE_ID });
}

Hooks.once("socketlib.ready", registerSocketHandlers);

Hooks.once("ready", async () => {
  log("ready: start");

  if (!game.modules.get("socketlib")?.active || !globalThis.socketlib) {
    ui.notifications.error("Orel: нужен модуль SocketLib (включи его) для работы Orel Death Aura.");
    warn("SocketLib inactive");
    return;
  }

  // Also register here if SocketLib's init hook ran before this module loaded.
  registerSocketHandlers();
  if (!OREL_SOCKET) {
    ui.notifications.error("Orel: не удалось зарегистрировать SocketLib. Перезапусти игровой мир.");
    return;
  }

  // preUpdateActor only runs on the requesting client. Pass the old HP through
  // operation options so the GM can detect committed updates from any player.
  Hooks.on("preUpdateActor", (actor, changes, options) => {
    const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (newHp !== undefined && newHp !== null) {
      options.orelDeathAuraPreviousHp = Number(actor.system.attributes.hp.value ?? 0);
    }
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

  Hooks.on("updateActor", async (deadActor, changes, options) => {
    try {
      if (!game.user.isActiveGM) return;
      const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
      if (newHp === undefined || newHp === null) return;

      const oldHp = options.orelDeathAuraPreviousHp;
      if (!(oldHp > 0 && Number(newHp) <= 0)) return;
      if (!shouldProcessDeath(deadActor.uuid)) return;

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
      await Promise.allSettled(ownerIds.map(async oid => {
        log("GM detector: send socket to owner", { oid, payload });
        await OREL_SOCKET.executeAsUser(SOCKET_FN, oid, payload);
      }));
    } catch (e) {
      warn("GM detector error", e);
    }
  });

  ui.notifications.info("Orel: Orel Death Aura активен.");
  log("ready: GM detector enabled");
});
