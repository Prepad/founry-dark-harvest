# Совместимость версии 1.5.0

Проверено 2026-10-10: сверка публичного API Foundry v13 и v14, исходников зависимостей и автоматические проверки на заглушках. Игровые серверы Foundry v13/v14 в этой среде не запускались; фактическая проверка в игровом мире остаётся отдельным этапом.

В манифесте указаны `minimum: "13"` и `verified: "14"`. Код использует один набор API, доступный в обеих версиях, без ветвления по версии Foundry. Название, ID модуля и ключи настроек сохранены; миграция существующих настроек не требуется.

## Изменения API

| Область | Результат проверки и исправление |
| --- | --- |
| Расстояние | `canvas.grid.measureDistance` удалён в v14. Используется `canvas.grid.measurePath([center1, center2]).distance`, доступный в v13 и v14. Измерение остаётся между центрами токенов в плоскости сцены и в её единицах расстояния; настройка в ft предполагает сцену в футах. |
| Настройки | Устаревшая FormApplication заменена на HandlebarsApplicationMixin(ApplicationV2). Контекст, обработка формы и слушатели работают через `_prepareContext`, обработчик `form.handler` и DOM. |
| Диалоги | Используется `DialogV2.wait` с именованными полями и `rejectClose: false`. Контент передаётся как HTMLDivElement, имена актёров и токенов экранируются. |
| Кубы и чат | Используется `foundry.dice.Roll.evaluate()`; асинхронный режим является стандартным. `ChatMessage.getSpeaker` получает Actor и TokenDocument. |
| Обновления Actor | `preUpdateActor` вызывается только у инициатора обновления. Он синхронно сохраняет предыдущие HP в опциях операции; `updateActor` на активном ГМе проверяет переход после сохранения. |
| SocketLib | Модуль регистрируется через `registerModule("orel-death-aura")`, имеет `socket: true` и не занимает канал системы dnd5e. Минимальная версия SocketLib — 1.1.3, чей манифест заявляет поддержку v14. |
| dnd5e | Используются `system.spells.spellN.value/max`, `system.uses.max/spent` и HP Actor. Сохранена поддержка старого формата Uses с `value`; лечение ограничено `effectiveMax`, если он доступен. |

## Зависимости

| Foundry | Вариант dnd5e | SocketLib |
| --- | --- | --- |
| v13 (13.347+) | 5.3.3: минимальный Foundry 13.347, заявлена поддержка v14 | 1.1.3+ |
| v14 | 5.3.3: один вариант системы для обеих версий Foundry | 1.1.3+ |
| v14 (14.367+) | 6.0.6: минимальный Foundry 14.367; не устанавливать на v13 | 1.1.3+ |

Версии зависимостей приведены по их манифестам. Это сверка совместимости и структуры API, а не результат запуска всех сочетаний в Foundry.

## Автоматические проверки

`node --test tests/orel-death-aura.test.cjs` проверяет расход ресурса, лечение, восстановление ячеек, отмену, возврат после ошибок, одновременные действия и unlinked-токен. Отдельные сценарии с контрактами API v13 и v14 проверяют запуск без старых глобальных классов, измерение радиуса, настройки V2, диалоги V2, изменения HP от игрока и выбор активного ГМа. Эти сценарии используют заглушки, соответствующие документации, а не исходный движок Foundry.

Сборка дополнительно проверяет наличие всех файлов, структуру ZIP, версию и идентичность манифеста и файлов в архиве исходникам. SHA-256 записывается рядом с архивом.

## Проверка в игровом мире

Для каждой версии Foundry с подходящими dnd5e и SocketLib:

1. Установить модуль, перезапустить мир и страницы ГМа и игрока. Открыть Open Config, проверить сохранение актёра, особенности и пресетов.
2. Разместить токен волшебника и существо в радиусе. Снизить положительные HP существа до 0 сначала с клиента ГМа, затем с клиента игрока. Диалог должен появиться у подключённого владельца волшебника.
3. Проверить цель вне радиуса, полный запас ячеек, полные HP, отмену диалога и исчерпанную особенность: ресурс не должен расходоваться.
4. Проверить успешное лечение и восстановление: эффект применяется, тратится ровно одно использование, бросок лечения появляется в чате.
5. Повторить для linked- и unlinked-токена. При двух ГМах событие обрабатывает только активный ГМ; отсутствующий владелец не блокирует остальных.

## Первичные источники

- [Удаления API в Foundry v14](https://github.com/foundryvtt/foundryvtt/issues/13436).
- [BaseGrid v13](https://foundryvtt.com/api/v13/classes/foundry.grid.BaseGrid.html) и [BaseGrid v14](https://foundryvtt.com/api/v14/classes/foundry.grid.BaseGrid.html).
- [ApplicationV2 v13](https://foundryvtt.com/api/v13/classes/foundry.applications.api.ApplicationV2.html) и [ApplicationV2 v14](https://foundryvtt.com/api/v14/classes/foundry.applications.api.ApplicationV2.html).
- [DialogV2 v13](https://foundryvtt.com/api/v13/classes/foundry.applications.api.DialogV2.html) и [DialogV2 v14](https://foundryvtt.com/api/v14/classes/foundry.applications.api.DialogV2.html).
- [preUpdateDocument](https://foundryvtt.com/api/v14/functions/hookEvents.preUpdateDocument.html) и [updateDocument](https://foundryvtt.com/api/v14/functions/hookEvents.updateDocument.html).
- [Roll v13](https://foundryvtt.com/api/v13/classes/foundry.dice.Roll.html) и [Roll v14](https://foundryvtt.com/api/v14/classes/foundry.dice.Roll.html).
- [SocketLib: API и манифест](https://github.com/farling42/foundryvtt-socketlib).
- Манифесты [dnd5e 5.3.3](https://raw.githubusercontent.com/foundryvtt/dnd5e/release-5.3.3/system.json) и [dnd5e 6.0.6](https://raw.githubusercontent.com/foundryvtt/dnd5e/release-6.0.6/system.json).
