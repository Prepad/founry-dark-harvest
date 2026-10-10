const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../scripts/orel-death-aura.js"), "utf8");
const getProperty = (object, key) => key.split(".").reduce((value, part) => value?.[part], object);
function setProperty(object, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  const parent = parts.reduce((current, part) => current[part] ??= {}, object);
  parent[last] = value;
}

function fixture({ uses = { max: 3, spent: 1 }, slot = { value: 1, max: 2 }, generation = 14 } = {}) {
  const notices = [];
  const updates = [];
  const requests = [];
  const handlers = new Map();
  const hooks = new Map();
  const feature = { id: "feature", name: "Death Aura", type: "feat", system: { uses: { ...uses } } };
  const items = new Map([[feature.id, feature]]);
  items.filter = predicate => [...items.values()].filter(predicate);
  items.find = predicate => [...items.values()].find(predicate);
  const wizard = {
    id: "wizard", uuid: "Actor.wizard", documentName: "Actor", name: "Wizard", type: "character", items,
    system: { details: { level: 1 }, spells: { spell1: { ...slot } }, attributes: { hp: { value: 10, max: 20 } } },
    testUserPermission: () => true,
    async update(changes) {
      updates.push({ kind: "wizard", changes });
      if (wizard.failUpdate) throw new Error("Actor update failed");
      for (const [key, value] of Object.entries(changes)) setProperty(wizard, key, value);
    },
    async updateEmbeddedDocuments(type, changes) {
      updates.push({ kind: "feature", changes });
      await Promise.resolve();
      if (wizard.failUsesUpdate) throw new Error("Item update failed");
      for (const change of changes) {
        const item = items.get(change._id);
        for (const [key, value] of Object.entries(change)) {
          if (key !== "_id") setProperty(item, key, value);
        }
      }
    }
  };
  const target = {
    id: "ally", uuid: "Actor.ally", documentName: "Actor", name: "Ally",
    system: { attributes: { hp: { value: 5, max: 10 } } },
    async update(changes) {
      updates.push({ kind: "target", changes });
      if (target.failUpdate) throw new Error("Target update failed");
      for (const [key, value] of Object.entries(changes)) setProperty(target, key, value);
    }
  };
  const wizardToken = { id: "wizardToken", name: "Wizard", actor: wizard, center: { x: 0, y: 0 }, document: { uuid: "Scene.test.Token.wizard" } };
  const targetToken = { id: "targetToken", name: "Ally", actor: target, center: { x: 0, y: 0 } };
  wizard.getActiveTokens = () => [wizardToken];
  const documents = new Map([[wizard.uuid, wizard], [target.uuid, target], [wizardToken.document.uuid, { actor: wizard }]]);
  const settings = new Map([
    ["wizardActor", wizard.id], ["usageFeature", feature.id],
    ["radiusProgression", JSON.stringify(Array(20).fill(30))],
    ["healDiceProgression", JSON.stringify(Array(20).fill("1d6"))],
    ["maxRestoreSlotLevelProgression", JSON.stringify(Array(20).fill(9))]
  ]);
  const context = {
    console: { log() {}, warn() {} },
    Hooks: { once: (name, callback) => hooks.set(name, callback), on: (name, callback) => hooks.set(name, callback) },
    foundry: {
      utils: { getProperty },
      applications: { api: {
        ApplicationV2: class {
          async _prepareContext() { return {}; }
          async _onRender() {}
        },
        HandlebarsApplicationMixin: Base => class extends Base {},
        DialogV2: { wait: () => { throw new Error("Unexpected dialog"); } }
      } },
      dice: { Roll: class {
        constructor() { this.total = 4; }
        async evaluate(options) { assert.equal(options, undefined); return this; }
        async toMessage() {}
      } }
    },
    ui: { notifications: Object.fromEntries(["info", "warn", "error"].map(kind => [kind, message => notices.push({ kind, message })])) },
    CONST: { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } },
    game: {
      release: { generation }, user: { id: "gm", isGM: true, isActiveGM: true }, system: { id: "dnd5e" }, users: [],
      actors: { get: id => id === wizard.id ? wizard : null, contents: [wizard] },
      settings: { get: (moduleId, key) => settings.get(key), set: async (moduleId, key, value) => settings.set(key, value),
        register() {}, registerMenu() {} },
      modules: new Map([["socketlib", { active: true }], ["orel-death-aura", { active: true, socket: true }]])
    },
    canvas: {
      ready: true,
      tokens: { placeables: [wizardToken, targetToken], get: id => [wizardToken, targetToken].find(token => token.id === id) },
      grid: { measurePath: () => ({ distance: 0 }) }
    },
    fromUuid: async uuid => documents.get(uuid),
    ChatMessage: { getSpeaker: () => ({}) },
    document: { createElement: tag => ({ tagName: tag.toUpperCase(), innerHTML: "" }) }
  };
  const socket = {
    register: (name, handler) => handlers.set(name, handler),
    async executeAsUser(name, userId, payload) { requests.push({ name, userId, payload }); },
    async executeAsGM(name, payload) {
      requests.push({ name, payload });
      const user = context.game.user;
      context.game.user = { id: "gm", isGM: true, isActiveGM: true };
      try {
        return await handlers.get(name)(payload);
      } finally {
        context.game.user = user;
      }
    }
  };
  context.socketlib = { registerModule: id => {
    assert.equal(id, "orel-death-aura");
    assert.equal(context.game.modules.get(id)?.socket, true);
    return socket;
  } };
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    context, wizard, feature, target, wizardToken, targetToken, notices, updates, requests, documents, settings, hooks, handlers,
    restorePayload: { wizardTokenUuid: wizardToken.document.uuid, featureItemId: feature.id, level: 1 },
    healPayload: { wizardTokenUuid: wizardToken.document.uuid, featureItemId: feature.id, targetActorUuid: target.uuid, amount: 4 },
    async ownerDialog(choice, { targetTokenId = targetToken.id } = {}) {
      context.game.user = { id: "owner", isGM: false };
      await hooks.get("ready")();
      context.dialogMainChoice = async () => choice;
      context.dialogPickHealTarget = async () => targetTokenId;
      return context.orelShowWizardDialog({ wizardActorId: wizard.id, deadName: "Enemy" });
    }
  };
}

test("modern max/spent uses appear correctly in config and the owner's dialog", async () => {
  const f = fixture({ uses: { max: 3, spent: 1, value: 0 } });
  const Config = vm.runInContext("OrelDeathAuraConfig", f.context);
  const data = await new Config()._prepareContext({});
  assert.equal(data.features[0].name, "Death Aura (2/3)");
  f.context.game.user = { id: "owner", isGM: false };
  let remaining;
  f.context.dialogMainChoice = async (name, radius, uses) => { remaining = uses.value; return null; };
  await f.context.orelShowWizardDialog({ wizardActorId: f.wizard.id });
  assert.equal(remaining, 2);
});

test("exhausted max/spent uses block the dialog even with a stale positive value", async () => {
  const f = fixture({ uses: { max: 3, spent: 3, value: 3 } });
  f.context.game.user.isGM = false;
  f.context.dialogMainChoice = () => { throw new Error("Exhausted feature must not open a dialog"); };
  await f.context.orelShowWizardDialog({ wizardActorId: f.wizard.id });
  assert.equal(f.notices.at(-1).message, "Использования пассивки закончились.");
  assert.equal(f.updates.length, 0);
});

test("successful restoration adds one slot and spends one modern use", async () => {
  const f = fixture();
  const result = await f.context.gmRestoreSlot(f.restorePayload);
  assert.equal(result.ok, true);
  assert.equal(f.wizard.system.spells.spell1.value, 2);
  assert.equal(f.feature.system.uses.spent, 2);
});

test("full and missing slots never spend a use", async () => {
  for (const slot of [{ value: 2, max: 2 }, { value: 0, max: 0 }]) {
    const f = fixture({ slot });
    const result = await f.context.gmRestoreSlot(f.restorePayload);
    assert.equal(result.ok, false);
    assert.equal(f.feature.system.uses.spent, 1);
    assert.equal(f.updates.length, 0);
  }
});

test("full slots and levels above the cap are disabled in the picker", () => {
  const f = fixture({ slot: { value: 2, max: 2 } });
  f.wizard.system.spells.spell2 = { value: 0, max: 1 };
  f.wizard.system.spells.spell3 = { value: 0, max: 1 };
  const options = f.context.buildSpellLevelOptions(f.wizard, { capLevel: 2 });
  assert.match(options, /value="1" disabled/);
  assert.match(options, /value="2" >/);
  assert.match(options, /value="3" disabled/);
});

test("no restorable slot within the cap closes the flow without opening a picker", async () => {
  const f = fixture({ slot: { value: 2, max: 2 } });
  f.wizard.system.spells.spell2 = { value: 0, max: 1 };
  const level = await f.context.dialogRestoreLevel(f.wizard, { capLevel: 1 });
  assert.equal(level, null);
  assert.equal(f.updates.length, 0);
});

test("a slot filled while the owner's dialog is open is rechecked on the GM", async () => {
  const f = fixture();
  f.context.dialogRestoreLevel = async () => {
    f.wizard.system.spells.spell1.value = 2;
    return 1;
  };
  await f.ownerDialog("restore");
  assert.equal(f.requests.length, 1);
  assert.equal(f.feature.system.uses.spent, 1);
  assert.equal(f.updates.length, 0);
  assert.match(f.notices.at(-1).message, /уже полные/);
});

test("legacy max/value items decrement value without creating a spent counter", async () => {
  const f = fixture({ uses: { max: 3, value: 2 } });
  const result = await f.context.gmRestoreSlot(f.restorePayload);
  assert.equal(result.ok, true);
  assert.equal(f.feature.system.uses.value, 1);
  assert.equal(f.feature.system.uses.spent, undefined);
});

test("exhausted modern and legacy items block both effects on the GM", async () => {
  for (const uses of [{ max: 3, spent: 3 }, { max: 3, value: 0 }]) {
    const f = fixture({ uses });
    assert.equal((await f.context.gmRestoreSlot(f.restorePayload)).ok, false);
    assert.equal((await f.context.gmApplyHeal(f.healPayload)).ok, false);
    assert.equal(f.updates.length, 0);
  }
});

test("unlimited mode and a feature without configured uses both apply without spending", async () => {
  for (const featureItemId of [undefined, "feature"]) {
    const f = fixture({ uses: { max: 0, spent: 0 } });
    const result = await f.context.gmRestoreSlot({ ...f.restorePayload, featureItemId });
    assert.equal(result.ok, true);
    assert.equal(f.wizard.system.spells.spell1.value, 2);
    assert.equal(f.updates.filter(update => update.kind === "feature").length, 0);
  }
});

test("healing is capped at maximum HP and spends exactly one use", async () => {
  const f = fixture();
  const result = await f.context.gmApplyHeal({ ...f.healPayload, amount: 20 });
  assert.equal(result.ok, true);
  assert.equal(f.target.system.attributes.hp.value, 10);
  assert.equal(f.feature.system.uses.spent, 2);
});

test("full HP and missing healing targets do not spend a use", async () => {
  const full = fixture();
  full.target.system.attributes.hp.value = 10;
  assert.equal((await full.context.gmApplyHeal(full.healPayload)).ok, false);
  assert.equal(full.updates.length, 0);
  const missing = fixture();
  missing.documents.delete(missing.target.uuid);
  assert.equal((await missing.context.gmApplyHeal(missing.healPayload)).ok, false);
  assert.equal(missing.updates.length, 0);
});

test("invalid restoration levels and healing amounts never spend a use", async () => {
  const f = fixture();
  for (const level of [0, 10, 1.5, NaN]) {
    assert.equal((await f.context.gmRestoreSlot({ ...f.restorePayload, level })).ok, false);
  }
  for (const amount of [0, -1, NaN, Infinity]) {
    assert.equal((await f.context.gmApplyHeal({ ...f.healPayload, amount })).ok, false);
  }
  assert.equal(f.updates.length, 0);
});

test("failed effect updates refund modern and legacy uses", async () => {
  for (const uses of [{ max: 3, spent: 1 }, { max: 3, value: 2 }]) {
    for (const action of ["restore", "heal"]) {
      const f = fixture({ uses });
      f.wizard.failUpdate = true;
      f.target.failUpdate = true;
      const result = action === "restore"
        ? await f.context.gmRestoreSlot(f.restorePayload)
        : await f.context.gmApplyHeal(f.healPayload);
      assert.equal(result.ok, false);
      assert.deepEqual(f.feature.system.uses, uses);
      assert.equal(f.wizard.system.spells.spell1.value, 1);
      assert.equal(f.target.system.attributes.hp.value, 5);
    }
  }
});

test("a failed resource update does not apply an effect", async () => {
  const f = fixture();
  f.wizard.failUsesUpdate = true;
  assert.equal((await f.context.gmApplyHeal(f.healPayload)).ok, false);
  assert.equal(f.target.system.attributes.hp.value, 5);
  assert.equal(f.feature.system.uses.spent, 1);
});

test("concurrent actions cannot both spend the last use", async () => {
  const f = fixture({ uses: { max: 1, spent: 0 } });
  const results = await Promise.all([
    f.context.gmRestoreSlot(f.restorePayload), f.context.gmApplyHeal(f.healPayload)
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(f.feature.system.uses.spent, 1);
  const applied = Number(f.wizard.system.spells.spell1.value === 2) + Number(f.target.system.attributes.hp.value === 9);
  assert.equal(applied, 1);
});

test("a refunded failed action does not block the next queued action", async () => {
  const f = fixture({ uses: { max: 1, spent: 0 } });
  f.target.failUpdate = true;
  const [failed, restored] = await Promise.all([
    f.context.gmApplyHeal(f.healPayload), f.context.gmRestoreSlot(f.restorePayload)
  ]);
  assert.equal(failed.ok, false);
  assert.equal(restored.ok, true);
  assert.equal(f.feature.system.uses.spent, 1);
  assert.equal(f.wizard.system.spells.spell1.value, 2);
});

test("non-GM clients cannot mutate HP or resources through the handlers", async () => {
  const f = fixture();
  f.context.game.user.isGM = false;
  assert.equal((await f.context.gmRestoreSlot(f.restorePayload)).ok, false);
  assert.equal((await f.context.gmApplyHeal(f.healPayload)).ok, false);
  assert.equal(f.updates.length, 0);
});

test("cancelling either dialog flow does not spend a use", async () => {
  for (const choice of [null, "restore", "heal"]) {
    const f = fixture();
    f.context.dialogRestoreLevel = async () => null;
    await f.ownerDialog(choice, { targetTokenId: null });
    assert.equal(f.requests.length, 0);
    assert.equal(f.updates.length, 0);
  }
});

test("invalid formulas and nonpositive rolls never request an effect", async () => {
  for (const total of [null, 0, -1]) {
    const f = fixture();
    f.context.foundry.dice.Roll = class {
      async evaluate() {
        if (total === null) throw new Error("Invalid formula");
        this.total = total;
        return this;
      }
      async toMessage() {}
    };
    await f.ownerDialog("heal");
    assert.equal(f.requests.length, 0);
    assert.equal(f.updates.length, 0);
  }
});

test("the owner's healing flow sends one combined GM request", async () => {
  const f = fixture();
  await f.ownerDialog("heal");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].payload.featureItemId, f.feature.id);
  assert.equal(f.feature.system.uses.spent, 2);
  assert.equal(f.target.system.attributes.hp.value, 9);
});

test("uses exhausted during the roll are checked again on the GM", async () => {
  const f = fixture({ uses: { max: 1, spent: 0 } });
  f.context.foundry.dice.Roll = class {
    async evaluate() { f.feature.system.uses.spent = 1; this.total = 4; return this; }
    async toMessage() {}
  };
  await f.ownerDialog("heal");
  assert.equal(f.requests.length, 1);
  assert.equal(f.target.system.attributes.hp.value, 5);
  assert.equal(f.updates.length, 0);
  assert.equal(f.notices.at(-1).message, "Использования пассивки закончились.");
});

test("an unlinked wizard uses the token actor's resources and slots", async () => {
  const f = fixture({ uses: { max: 3, spent: 3 }, slot: { value: 2, max: 2 } });
  const tokenFeature = { ...f.feature, system: { uses: { max: 3, spent: 1 } } };
  const tokenActor = {
    ...f.wizard, uuid: "Scene.test.Token.wizard.Actor.wizard", items: new Map([[tokenFeature.id, tokenFeature]]),
    system: { details: { level: 1 }, spells: { spell1: { value: 1, max: 2 } } },
    async update(changes) {
      for (const [key, value] of Object.entries(changes)) setProperty(tokenActor, key, value);
    },
    async updateEmbeddedDocuments(type, changes) {
      for (const change of changes) {
        for (const [key, value] of Object.entries(change)) {
          if (key !== "_id") setProperty(tokenFeature, key, value);
        }
      }
    }
  };
  f.wizardToken.actor = tokenActor;
  f.documents.set(f.wizardToken.document.uuid, { actor: tokenActor });
  f.context.dialogRestoreLevel = async actor => {
    assert.equal(actor, tokenActor);
    return 1;
  };
  await f.ownerDialog("restore");
  assert.equal(f.requests.length, 1);
  assert.equal(tokenActor.system.spells.spell1.value, 2);
  assert.equal(tokenFeature.system.uses.spent, 2);
  assert.equal(f.feature.system.uses.spent, 3);
  assert.equal(f.wizard.system.spells.spell1.value, 2);
});

for (const generation of [13, 14]) {
  test(`v${generation} API contract: startup uses a module socket without legacy globals`, async () => {
    const f = fixture({ generation });
    for (const name of ["Dialog", "FormApplication", "Handlebars", "$", "Roll"]) {
      Object.defineProperty(f.context, name, { get() { throw new Error(`Legacy global ${name} used`); } });
    }
    let registrations = 0;
    f.context.socketlib.registerModule = id => {
      registrations++;
      assert.equal(id, "orel-death-aura");
      return { register: (name, handler) => f.handlers.set(name, handler) };
    };
    await f.hooks.get("init")();
    await f.hooks.get("socketlib.ready")();
    await f.hooks.get("ready")();
    assert.equal(registrations, 1);
    assert.equal(f.handlers.size, 3);
    const Config = vm.runInContext("OrelDeathAuraConfig", f.context);
    assert.equal(new Config() instanceof f.context.foundry.applications.api.ApplicationV2, true);
    assert.equal(Config.DEFAULT_OPTIONS.tag, "form");
    assert.equal(f.hooks.has("updateActor"), true);
  });

  test(`v${generation} API contract: distance uses measurePath and handles an inactive canvas`, () => {
    const f = fixture({ generation });
    f.context.canvas.grid.measureDistance = () => { throw new Error("Removed method used"); };
    f.context.canvas.grid.measurePath = waypoints => {
      assert.equal(waypoints[0], f.wizardToken.center);
      assert.equal(waypoints[1], f.targetToken.center);
      return { distance: 25, cost: 99 };
    };
    assert.equal(f.context.distFt(f.wizardToken, f.targetToken), 25);
    f.context.canvas.ready = false;
    assert.equal(f.context.distFt(f.wizardToken, f.targetToken), Infinity);
    assert.equal(f.context.getActiveTokenForActor(f.wizard), null);
  });

  test(`v${generation} API contract: V2 config preserves selections, presets and form submission`, async () => {
    const f = fixture({ generation });
    const Config = vm.runInContext("OrelDeathAuraConfig", f.context);
    const config = new Config();
    const data = await config._prepareContext({});
    assert.equal(data.actors[0].selected, true);
    assert.equal(data.features[0].selected, true);
    const controls = new Map();
    const root = {
      setAttribute() {},
      querySelector(selector) {
        if (!controls.has(selector)) controls.set(selector, {
          value: "", addEventListener(name, callback) { this.change = callback; }
        });
        return controls.get(selector);
      }
    };
    config.element = root;
    await config._onRender({}, {});
    for (const [picker, field, key, expected] of [
      ["radiusPreset", "radiusProgression", "30-flat", 30],
      ["healDicePreset", "healDiceProgression", "1d6-flat", "1d6"],
      ["maxRestorePreset", "maxRestoreSlotLevelProgression", "cap3", 3]
    ]) {
      const control = controls.get(`select[name="${picker}"]`);
      control.value = key;
      control.change({ currentTarget: control });
      const values = JSON.parse(controls.get(`textarea[name="${field}"]`).value);
      assert.equal(values.length, 20);
      assert.equal(values.every(value => value === expected), true);
      assert.equal(control.value, "");
    }
    const formData = {
      wizardActor: "wizard", usageFeature: "feature", radiusProgression: "[20]",
      healDiceProgression: '["2d6"]', maxRestoreSlotLevelProgression: "[3]"
    };
    await Config.DEFAULT_OPTIONS.form.handler.call(config, {}, root, { object: formData });
    for (const [key, value] of Object.entries(formData)) assert.equal(f.settings.get(key), value);
    const template = fs.readFileSync(path.join(__dirname, "../templates/config.hbs"), "utf8");
    assert.doesNotMatch(template, /<form\b/);
    assert.doesNotMatch(template, /\(eq\b/);
  });

  test(`v${generation} API contract: all DialogV2 choices return selected values and support cancellation`, async () => {
    const f = fixture({ generation });
    f.target.testUserPermission = () => true;
    f.context.game.users = [{ id: "owner", active: true, isGM: false }];
    const shown = [];
    f.context.foundry.applications.api.DialogV2.wait = async options => {
      shown.push(options);
      assert.equal(options.content.tagName, "DIV");
      assert.equal(options.rejectClose, false);
      const button = options.buttons.find(entry => entry.default);
      return button.callback ? button.callback({}, { form: { elements: {
        targetTokenId: { value: f.targetToken.id }, spellLevel: { value: "1" }
      } } }) : button.action;
    };
    assert.equal(await f.context.dialogMainChoice('<img src=x onerror="alert(1)">', 30, { value: 2, max: 3, hasUses: true }), "heal");
    assert.doesNotMatch(shown[0].content.innerHTML, /<img\b/);
    assert.match(shown[0].content.innerHTML, /&lt;img/);
    assert.equal(await f.context.dialogPickHealTarget(f.wizardToken, f.wizard, { radiusFt: 30 }), f.targetToken.id);
    assert.match(shown[1].content.innerHTML, /name="targetTokenId"/);
    assert.equal(await f.context.dialogRestoreLevel(f.wizard, { capLevel: 9 }), 1);
    assert.match(shown[2].content.innerHTML, /name="spellLevel"/);
    for (const options of shown) assert.equal(options.buttons.find(button => button.action === "cancel").callback(), null);
    f.context.foundry.applications.api.DialogV2.wait = async () => null;
    assert.equal(await f.context.dialogMainChoice("Enemy", 30), null);
  });

  test(`v${generation} API contract: player HP updates trigger only the active GM after commit`, async () => {
    const player = fixture({ generation });
    player.context.game.user = { id: "owner", isGM: false };
    await player.hooks.get("ready")();
    const changes = { system: { attributes: { hp: { value: 0 } } } };
    const options = {};
    const before = player.hooks.get("preUpdateActor")(player.wizard, changes, options);
    assert.equal(before, undefined);
    assert.equal(options.orelDeathAuraPreviousHp, 10);
    assert.equal(player.requests.length, 0);

    const gm = fixture({ generation });
    gm.context.game.users = [
      { id: "owner", active: true, isGM: false },
      { id: "offline", active: false, isGM: false },
      { id: "gm", active: true, isGM: true }
    ];
    await gm.hooks.get("ready")();
    gm.wizard.system.attributes.hp.value = 0;
    gm.context.game.user.isActiveGM = false;
    await gm.hooks.get("updateActor")(gm.wizard, changes, options);
    assert.equal(gm.requests.length, 0);
    gm.context.game.user.isActiveGM = true;
    await gm.hooks.get("updateActor")(gm.wizard, changes, options);
    assert.equal(gm.requests.length, 1);
    assert.equal(gm.requests[0].userId, "owner");
    await gm.hooks.get("updateActor")(gm.wizard, changes, options);
    assert.equal(gm.requests.length, 1);
    await gm.hooks.get("updateActor")(gm.wizard, changes, { orelDeathAuraPreviousHp: 0 });
    assert.equal(gm.requests.length, 1);
  });

  test(`v${generation} API contract: healing respects effectiveMax and uses a TokenDocument speaker`, async () => {
    const f = fixture({ generation });
    f.target.system.attributes.hp.effectiveMax = 7;
    f.context.ChatMessage.getSpeaker = ({ actor, token }) => {
      assert.equal(actor, f.wizard);
      assert.equal(token, f.wizardToken.document);
      return {};
    };
    await f.ownerDialog("heal");
    assert.equal(f.target.system.attributes.hp.value, 7);
    assert.equal(f.feature.system.uses.spent, 2);
  });
}
