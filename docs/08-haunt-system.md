# 08 — Haunt System

50 haunts, each with its own setup, monsters, special rules, and win
conditions. This is the bulk of the remaining work after the vertical slice,
and it is the part most likely to turn into 4,000 lines of `switch (hauntId)`.

The strategy: **a declarative trigger/effect vocabulary that covers the
common cases, plus a TypeScript escape hatch for the genuinely weird ones.**
Do not try to make the DSL Turing-complete. The moment a haunt fights the DSL,
write it as a script module and move on.

Expect roughly 65–75% of haunts to be pure data. That is a win. Chasing 100%
is how this project dies.

## 8.1 Haunt definition

```ts
const HauntSchema = z.object({
  id: z.number().int().min(1).max(50),
  name: z.string(),
  traitorRule: TraitorRuleSchema,
  setup: z.array(EffectSchema),
  monsters: z.array(MonsterDefSchema).default([]),
  traitor: SideSchema,
  heroes: SideSchema,
  rules: z.array(TriggerRuleSchema).default([]),
  scriptId: z.string().optional(), // escape hatch, see 8.5
  implemented: z.boolean().default(false),
});

const SideSchema = z.object({
  goal: z.string(), // prose shown to that side only
  rules: z.array(z.string()), // prose bullets shown to that side only
  win: z.array(ConditionSchema), // machine-checked win conditions
});

const TraitorRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: 'trigger' }), // whoever drew the omen
  z.object({ kind: 'highest', trait: TraitSchema }),
  z.object({ kind: 'lowest', trait: TraitSchema }),
  z.object({ kind: 'holder', cardId: z.string() }),
  z.object({ kind: 'none' }), // survival haunts
]);
```

`implemented: false` haunts still load: the game reveals the haunt, shows both
sides their prose, and then runs in **manual mode** — the engine enforces
movement, dice, and combat, but win conditions are declared by a majority vote
control in the UI. This means the game is _playable end to end_ from M4 even
with 45 haunts unwritten, which is a much better failure mode than a crash.

## 8.2 Conditions

```ts
type Condition =
  | { k: 'all_dead'; side: 'heroes' | 'traitor' | 'monsters' }
  | { k: 'seat_dead'; who: SeatRef }
  | { k: 'in_room'; who: SeatRef; tile: TileId }
  | { k: 'holds'; who: SeatRef; cardId: CardId }
  | { k: 'trait_at_least'; who: SeatRef; trait: Trait; value: number }
  | {
      k: 'flag';
      scope: 'game' | 'seat' | 'tile';
      key: string;
      op: '=' | '>=' | '<=';
      value: number | boolean | string;
      ref?: string;
    }
  | { k: 'count'; of: CountableRef; op: '>=' | '<=' | '='; value: number }
  | { k: 'turns_elapsed'; op: '>='; value: number }
  | { k: 'not'; c: Condition }
  | { k: 'and'; cs: Condition[] }
  | { k: 'or'; cs: Condition[] };
```

`SeatRef` resolves to seats: `'actor' | 'traitor' | 'any_hero' | 'all_heroes'
| { seat: SeatId }`. Conditions with `any_`/`all_` quantifiers evaluate over
the resolved set.

## 8.3 Effects

The same `Effect` type is used by card `onDraw`/`onUse`, tile `onEnter`, haunt
`setup`, and rule consequences. One interpreter, in
`engine/src/systems/effects.ts`.

```ts
type Effect =
  | { e: 'trait'; who: SeatRef; trait: Trait; delta: number } // steps, not value
  | { e: 'roll'; who: SeatRef; trait: Trait; then: Branch[] } // branch on total
  | { e: 'move'; who: SeatRef; to: RoomRef }
  | { e: 'give_card'; who: SeatRef; card: CardRef }
  | { e: 'take_card'; who: SeatRef; card: CardRef; to: 'discard' | 'room' }
  | { e: 'spawn_monster'; def: string; at: RoomRef; count: number | DiceRef }
  | { e: 'kill'; who: SeatRef | MonsterRef }
  | { e: 'place_token'; token: string; at: RoomRef }
  | {
      e: 'set_flag';
      scope: 'game' | 'seat' | 'tile';
      key: string;
      value: number | boolean | string;
      ref?: SeatRef | RoomRef;
    }
  | { e: 'prompt'; who: SeatRef; prompt: PromptSpec; then: Branch[] }
  | { e: 'end_turn'; who: SeatRef }
  | { e: 'log'; text: string }
  | { e: 'if'; c: Condition; then: Effect[]; else?: Effect[] }
  | { e: 'for_each'; who: SeatRef; do: Effect[] }
  | { e: 'script'; id: string; args?: Record<string, unknown> }; // escape hatch
```

`RoomRef` covers `'actor_room' | 'entrance_hall' | { tile: TileId } |
{ random: Floor } | 'landing:<floor>'`.

Two things to get right early, because retrofitting them is painful:

- **`trait` deltas are track steps, never printed values.** See
  [02-rules-model.md](02-rules-model.md#22-explorers-and-traits).
- **Every effect list is resolved sequentially and may suspend on a prompt.**
  The interpreter therefore carries a resume cursor into `pending.payload`,
  exactly like the discovery pipeline in
  [05-engine.md](05-engine.md#56-worked-example-discovering-a-room). Build the
  suspend/resume mechanism once, in the interpreter, and everything else
  inherits it.

## 8.4 Trigger rules

```ts
const TriggerRuleSchema = z.object({
  id: z.string(),
  on: z.enum([
    'turn_start',
    'turn_end',
    'round_end',
    'enter_room',
    'leave_room',
    'discover_room',
    'draw_card',
    'attack_declared',
    'attack_resolved',
    'damage_taken',
    'death',
    'item_used',
    'haunt_start',
  ]),
  who: SeatRefSchema.default('actor'),
  when: ConditionSchema.optional(),
  do: z.array(EffectSchema),
  once: z.boolean().default(false),
  priority: z.number().default(0),
});
```

The reducer fires triggers at fixed points. Rules from all active sources —
the haunt, cards in play, tiles the actor is in, monster definitions — are
collected, filtered by `when`, sorted by `priority` then by source order, and
run. `once` rules record their firing in `state` flags.

Trigger points are a fixed enum on purpose. Adding a new one is a deliberate
engine change with a test, not something content can invent.

## 8.5 The script escape hatch

Some haunts will not fit. That is expected and fine.

```ts
// engine/src/haunts/scripts/h023_the_mirror.ts
export const h023: HauntScript = {
  id: 'h023',
  setup(ctx) { … },
  onTrigger(ctx, point, payload) { … },
  checkWin(ctx) { … },
};
```

`HauntScript` receives a `ctx` exposing the same effect interpreter and
selectors the DSL uses, so a script is "data plus arbitrary control flow", not
a parallel implementation of the game. Scripts are registered in one map;
`scriptId` in the haunt JSON selects one.

Rules for scripts:

- A script may read state and emit effects. It may **not** mutate state
  directly. Same purity guarantee as everything else in the engine.
- If three scripts want the same helper, promote it to an `Effect` and delete
  the duplication.
- Every script needs at least one scripted-game test that reaches its win
  condition. This is the only way 50 haunts stay maintainable.

## 8.6 Monsters

```ts
const MonsterDefSchema = z.object({
  def: z.string(), // "zombie", referenced by spawn_monster
  name: z.string(),
  speed: z.number().nullable(),
  might: z.number().nullable(),
  canBeDamaged: z.boolean().default(true),
  canBeKilled: z.boolean().default(true),
  stunnedInstead: z.boolean().default(false),
  movement: z
    .enum(['normal', 'ignore_doors', 'through_walls', 'stationary'])
    .default('normal'),
  rules: z.array(TriggerRuleSchema).default([]),
});
```

Monsters act on the traitor's turn. The traitor moves and attacks with each in
turn; the UI presents them as a queue with a "done with this monster" control.
Monster AI is **not** implemented — the traitor is a human and controls them,
which is exactly how the physical game works.

## 8.7 Authoring workflow for the remaining 45

Once M4 ships, the loop for each haunt is:

1. Read the haunt in the Traitor's Tome / Secrets of Survival.
2. Write the JSON: traitor rule, setup, monsters, both sides' prose, win
   conditions.
3. Try to express special rules as trigger rules. **Timebox this to 30
   minutes.** If it does not fit, write a script module instead.
4. Write one scripted-game test that reaches the traitor win and one that
   reaches the hero win.
5. Flip `implemented: true`.

Batch these by similarity — the "kill all X" haunts, the "reach room Y"
haunts, the "collect N tokens" haunts — because each batch shares effects, and
the second haunt in a batch takes a fraction of the time of the first. Track
progress as a simple count in the roadmap.
