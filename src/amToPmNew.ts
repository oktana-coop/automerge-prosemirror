import { next as am, Patch, type Prop } from "@automerge/automerge/slim"
import { Slice, Node, DOMSerializer } from "prosemirror-model"
import { Transaction } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"
import { amSpliceIdxToPmIdx, pmDocFromSpans } from "./traversal.js"
import { applyPatchToSpans } from "./maintainSpans.js"
import { isPrefixOfArray, isArrayEqual } from "./utils.js"
import { ReplaceStep } from "prosemirror-transform"
import { pmMarksFromAmMarks, SchemaAdapter } from "./schema.js"
import { charPath, patchContentToFragment, findDiff } from "./amToPm.js"
import { ChangeSet } from "prosemirror-changeset"

export const diffInsert = "bg-green-300"
export const diffModify = "bg-purple-100"
export const diffDelete = "bg-red-200"

export const isBlockPatch = (patch: Patch): boolean => {
  return patch.action === "insert" || patch.action === "put"
}

type SpliceTextPatchGroup = {
  type: "splice"
  patches: Array<am.SpliceTextPatch>
}

type DelPatchGroup = {
  type: "del"
  patches: Array<am.DelPatch>
}

type MarkPatchGroup = {
  type: "mark"
  patches: Array<am.MarkPatch>
}

// For some reason `UnmarkPatch` is not exported from `@automerge/automerge/slim`
// so we have to redefine it here.
type UnmarkPatch = {
  action: "unmark"
  path: Prop[]
  name: string
  start: number
  end: number
}

type UnmarkPatchGroup = {
  type: "unmark"
  patches: Array<UnmarkPatch>
}

type InsertBlockPatchGroup = {
  type: "insertBlock"
  patches: Array<am.InsertPatch | am.PutPatch>
}

type UpdateBlockPatchGroup = {
  type: "updateBlock"
  patches: Array<am.PutPatch>
}

type UpdateBlockHierarchyPatchGroup = {
  type: "updateBlockHierarchy"
  patches: Array<am.PutPatch>
}

type UpdateBlockTypeAndAttrsPatchGroup = {
  type: "updateBlockTypeAndAttrs"
  patches: Array<am.PutPatch>
}

type PatchGroup =
  | SpliceTextPatchGroup
  | DelPatchGroup
  | MarkPatchGroup
  | UnmarkPatchGroup
  | InsertBlockPatchGroup
  | UpdateBlockPatchGroup
  | UpdateBlockHierarchyPatchGroup
  | UpdateBlockTypeAndAttrsPatchGroup

const isBlockPatchIndexGroup = (group: Array<Patch>): boolean =>
  group.every(patch => patch.action === "insert" || patch.action === "put")

const isBlockPatchGroupWithStructureChanges = (group: PatchGroup) =>
  group.type === "insertBlock" ||
  group.type === "updateBlockHierarchy" ||
  group.type === "updateBlock"

export default function (
  adapter: SchemaAdapter,
  spans: am.Span[],
  patches: Array<Patch>,
  path: Prop[],
  tx: Transaction,
  diffMode = false,
): Transaction {
  const pmDocBefore = tx.doc
  const patchGroups = filterAndGroupPatches(patches, path)

  const result = patchGroups.reduce<{
    tx: Transaction
    spans: Array<am.Span>
    decorations: Decoration[]
  }>(
    (acc, patchGroup) => {
      switch (patchGroup.type) {
        case "splice":
          return updateTransactionAndApplySpansForNonBlockPatchGroup({
            tx: acc.tx,
            path,
            adapter,
            spans: acc.spans,
            diffMode,
            decorations: acc.decorations,
          })({
            patchGroup,
            updateTransactionFromPatchFn: updateTransactionFromSplicePatch,
          })
        case "mark":
          return updateTransactionAndApplySpansForNonBlockPatchGroup({
            tx: acc.tx,
            path,
            adapter,
            spans: acc.spans,
            diffMode,
            decorations: acc.decorations,
          })({
            patchGroup,
            updateTransactionFromPatchFn: updateTransactionFromMarkPatch,
          })
        case "del":
          return updateTransactionAndApplySpansForNonBlockPatchGroup({
            tx: acc.tx,
            path,
            adapter,
            spans: acc.spans,
            diffMode,
            decorations: acc.decorations,
          })({
            patchGroup,
            updateTransactionFromPatchFn: updateTransactionFromDelPatch,
          })
        case "insertBlock":
        case "updateBlockHierarchy":
        case "updateBlock":
          return updateTransactionAndApplySpansForBlockPatchGroup({
            patchGroup,
            tx: acc.tx,
            path,
            adapter,
            spans: acc.spans,
            decorations: acc.decorations,
          })
        case "updateBlockTypeAndAttrs":
          return updateTransactionAndApplySpansForUpdateBlockTypeAndAttrsPatchGroup(
            {
              patchGroup,
              tx: acc.tx,
              path,
              adapter,
              spans: acc.spans,
              diffMode,
              decorations: acc.decorations,
            },
          )
        default:
          // No update to the ProseMirror transaction but we still update the Automerge spans.
          return {
            tx: acc.tx,
            spans: applyPatchGroupSpans({
              patchGroup,
              initialSpans: acc.spans,
              path,
            }),
            decorations: acc.decorations,
          }
      }
    },
    { tx, spans, decorations: [] },
  )

  if (diffMode && patchGroups.some(isBlockPatchGroupWithStructureChanges)) {
    const { changes } = ChangeSet.create(pmDocBefore).addSteps(
      result.tx.doc,
      result.tx.mapping.maps,
      [],
    )

    const newDecorations = changes.reduce<Decoration[]>(
      (acc, { fromB, inserted }) => {
        const { decorations: newInsertDecorations } = inserted.reduce<{
          decorations: Decoration[]
          nextInsertMarkStart: number
        }>(
          (acc, span) => {
            const decoration = Decoration.inline(
              acc.nextInsertMarkStart,
              acc.nextInsertMarkStart + span.length,
              { class: diffInsert },
            )

            return {
              decorations: acc.decorations.concat([decoration]),
              nextInsertMarkStart: acc.nextInsertMarkStart + span.length,
            }
          },
          { decorations: [], nextInsertMarkStart: fromB },
        )

        return acc.concat(newInsertDecorations)
      },
      [],
    )

    result.decorations = result.decorations.concat(newDecorations)
  }

  // Apply decorations to the transaction
  const decorationSet = DecorationSet.create(result.tx.doc, result.decorations)
  result.tx.setMeta("decorations", decorationSet)

  return result.tx
}

const applyPatchGroupSpans = ({
  patchGroup,
  initialSpans,
  path,
}: {
  patchGroup: PatchGroup
  initialSpans: am.Span[]
  path: Prop[]
}): am.Span[] =>
  patchGroup.patches.reduce<Array<am.Span>>((accSpans, patch) => {
    const newSpans = applyPatchToSpans(path, accSpans, patch)
    return newSpans
  }, initialSpans)

const groupContainsOnlyTypeAndAttrs = (group: Array<Patch>): boolean =>
  group.every(
    patch =>
      patch.action === "put" &&
      (patch.path[2] === "type" || patch.path[2] === "attrs"),
  )

const filterAndGroupPatches = (
  patches: Array<Patch>,
  path: Prop[],
): Array<PatchGroup> => {
  const pathPatches = patches.filter(patch => isPrefixOfArray(path, patch.path))

  const patchIndexGroups = Array.from(
    pathPatches
      .reduce<Map<string, Array<Patch>>>((acc, patch) => {
        if (patch.action === "mark") {
          acc.set(`mark${patch.marks[0].start}-${patch.marks[0].end}`, [patch])
        }

        const index = patch.path[1]
        if (typeof index !== "number") {
          return acc
        }

        const group = acc.get(index.toString())
        if (group) {
          group.push(patch)
        } else {
          acc.set(index.toString(), [patch])
        }

        return acc
      }, new Map())
      .values(),
  )

  const patchGroups = patchIndexGroups
    // Split non-block patches into separate groups
    .reduce<Array<Array<am.Patch>>>((acc, group) => {
      if (group.length > 1 && !isBlockPatchIndexGroup(group)) {
        return [...acc, ...group.map(patch => [patch])]
      }

      return [...acc, group]
    }, [])
    // Construct block patch groups depending on patch types
    .reduce<Array<PatchGroup>>((acc, group) => {
      switch (group[0].action) {
        case "splice":
          return [
            ...acc,
            {
              type: "splice",
              patches: group,
            } as SpliceTextPatchGroup,
          ]
        case "del":
          return [
            ...acc,
            {
              type: "del",
              patches: group,
            } as DelPatchGroup,
          ]
        case "mark":
          return [
            ...acc,
            {
              type: "mark",
              patches: group,
            } as MarkPatchGroup,
          ]
        case "unmark":
          return [
            ...acc,
            {
              type: "unmark",
              patches: group,
            } as UnmarkPatchGroup,
          ]
        case "insert":
          return [
            ...acc,
            {
              type: "insertBlock",
              patches: group,
            } as InsertBlockPatchGroup,
          ]
        case "put":
          if (group.length === 1 && group[0].path[2] === "parents") {
            return [
              ...acc,
              {
                type: "updateBlockHierarchy",
                patches: group,
              } as UpdateBlockHierarchyPatchGroup,
            ]
          }

          if (groupContainsOnlyTypeAndAttrs(group)) {
            return [
              ...acc,
              {
                type: "updateBlockTypeAndAttrs",
                patches: group,
              } as UpdateBlockTypeAndAttrsPatchGroup,
            ]
          }

          return [
            ...acc,
            {
              type: "updateBlock",
              patches: group,
            } as UpdateBlockPatchGroup,
          ]
        default:
          return acc
      }
    }, [])

  return patchGroups
}

type UpdateTransactionAndApplySpansForNonBlockPatchGroup = (context: {
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
  decorations: Decoration[]
}) => (
  groupArgs:
    | {
        patchGroup: SpliceTextPatchGroup
        updateTransactionFromPatchFn: UpdateTransactionFromSplicePatchFn
      }
    | {
        patchGroup: MarkPatchGroup
        updateTransactionFromPatchFn: UpdateTransactionFromMarkPatchFn
      }
    | {
        patchGroup: DelPatchGroup
        updateTransactionFromPatchFn: UpdateTransactionFromDelPatchFn
      },
) => { tx: Transaction; spans: am.Span[]; decorations: Decoration[] }

const updateTransactionAndApplySpansForNonBlockPatchGroup: UpdateTransactionAndApplySpansForNonBlockPatchGroup =

    ({ tx, path, adapter, spans, diffMode, decorations }) =>
    ({ patchGroup, updateTransactionFromPatchFn }) =>
      patchGroup.patches.reduce<{
        tx: Transaction
        spans: Array<am.Span>
        decorations: Array<Decoration>
      }>(
        (groupAcc, patch) => {
          const { tx: updatedTx, decorations: newDecorations } =
            updateTransactionFromPatchFn({
              // @ts-expect-error TS cannot infer that the type is correct here according to the group args type
              patch,
              tx: groupAcc.tx,
              path,
              adapter,
              spans: groupAcc.spans,
              diffMode,
              decorations: groupAcc.decorations,
            })

          const newSpans = applyPatchToSpans(path, groupAcc.spans, patch)
          const updatedDecorations = decorations.concat(newDecorations)

          return {
            tx: updatedTx,
            spans: newSpans,
            decorations: updatedDecorations,
          }
        },
        { tx, spans, decorations: [] },
      )

type UpdateTransactionFromSplicePatchFn = (args: {
  patch: am.SpliceTextPatch
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}) => { tx: Transaction; decorations: Decoration[] }

const updateTransactionFromSplicePatch: UpdateTransactionFromSplicePatchFn = ({
  patch,
  tx,
  path,
  adapter,
  spans,
  diffMode,
}) => {
  const index = charPath(path, patch.path)
  if (index === null) {
    return {
      tx,
      decorations: [],
    }
  }

  const pmIdx = amSpliceIdxToPmIdx(adapter, spans, index)
  if (pmIdx == null) throw new Error("Invalid index")
  const content = patchContentToFragment(adapter, patch.value, patch.marks)
  tx = tx.step(new ReplaceStep(pmIdx, pmIdx, new Slice(content, 0, 0)))

  const decorations = diffMode
    ? [
        Decoration.inline(pmIdx, pmIdx + content.size, {
          class: diffInsert,
        }),
      ]
    : []

  return {
    tx,
    decorations,
  }
}

type UpdateTransactionFromMarkPatchFn = (args: {
  patch: am.MarkPatch
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}) => { tx: Transaction; decorations: Decoration[] }

const updateTransactionFromMarkPatch: UpdateTransactionFromMarkPatchFn = ({
  patch,
  tx,
  path,
  adapter,
  spans,
  diffMode,
}) => {
  const decorations = []

  if (isArrayEqual(patch.path, path)) {
    for (const mark of patch.marks) {
      const pmStart = amSpliceIdxToPmIdx(adapter, spans, mark.start)
      const pmEnd = amSpliceIdxToPmIdx(adapter, spans, mark.end)
      if (pmStart == null || pmEnd == null) throw new Error("Invalid index")
      if (mark.value == null) {
        const markMapping = adapter.markMappings.find(
          m => m.automergeMarkName === mark.name,
        )
        const markType = markMapping
          ? markMapping.prosemirrorMark
          : adapter.unknownMark
        tx = tx.removeMark(pmStart, pmEnd, markType)
        if (diffMode) {
          const decoration = Decoration.inline(pmStart, pmEnd, {
            class: diffModify,
          })
          decorations.push(decoration)
        }
      } else {
        const pmMarks = pmMarksFromAmMarks(adapter, {
          [mark.name]: mark.value,
        })
        for (const pmMark of pmMarks) {
          tx = tx.addMark(pmStart, pmEnd, pmMark)
          if (diffMode) {
            const decoration = Decoration.inline(pmStart, pmEnd, {
              class: diffModify,
            })
            decorations.push(decoration)
          }
        }
      }
    }
  }

  return { tx, decorations }
}

type UpdateTransactionFromDelPatchFn = (args: {
  patch: am.DelPatch
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}) => { tx: Transaction; decorations: Decoration[] }

const createDeleteDecorationForNode = ({
  start,
  node,
  adapter,
}: {
  start: number
  node: Node
  adapter: SchemaAdapter
}): Decoration => {
  const createInlineElement = (docFragment: globalThis.Node) => {
    const element = document.createElement("span")
    element.className = diffDelete
    element.appendChild(docFragment)
    return element
  }

  const createBlockElement = (docFragment: globalThis.Node) => {
    const element = document.createElement("div")
    element.appendChild(docFragment)

    element.querySelectorAll("*").forEach(el => {
      if (el instanceof HTMLElement) {
        const text = el.innerText.trim()
        if (text) {
          const span = document.createElement("span")
          span.className = diffDelete
          span.innerText = text
          el.innerText = ""
          el.appendChild(span)
        }
      }
    })
    return element
  }

  const decoration = Decoration.widget(start, () => {
    const domSerializer = DOMSerializer.fromSchema(adapter.schema)
    const docFragment = domSerializer.serializeNode(node)

    if (node.isInline) {
      return createInlineElement(docFragment)
    }

    return createBlockElement(docFragment)
  })

  return decoration
}

const createDeleteDecorations = ({
  doc,
  adapter,
  start,
  end,
}: {
  doc: Node
  adapter: SchemaAdapter
  start: number
  end: number
}): Decoration[] => {
  const slice = doc.slice(
    Math.min(start, doc.content.size),
    Math.min(end, doc.content.size),
  )

  const { decorations } = slice.content.content.reduce<{
    decorations: Decoration[]
    nextDecorationStart: number
  }>(
    (acc, node) => {
      const decoration = createDeleteDecorationForNode({ start, node, adapter })

      return {
        decorations: acc.decorations.concat([decoration]),
        nextDecorationStart: acc.nextDecorationStart + node.nodeSize,
      }
    },
    { decorations: [], nextDecorationStart: start },
  )

  return decorations
}

const updateTransactionFromDelPatch: UpdateTransactionFromDelPatchFn = ({
  patch,
  tx,
  path,
  adapter,
  spans,
  diffMode,
}) => {
  const index = charPath(path, patch.path)
  if (index === null) {
    return { tx, decorations: [] }
  }
  const start = amSpliceIdxToPmIdx(adapter, spans, index)
  if (start == null) throw new Error("Invalid start index in deletion")
  const end = amSpliceIdxToPmIdx(adapter, spans, index + (patch.length || 1))
  if (end == null) throw new Error("Invalid end index in deletion")

  const decorations = diffMode
    ? createDeleteDecorations({ doc: tx.doc, adapter, start, end })
    : []

  tx = tx.delete(start, end)

  return {
    tx,
    decorations,
  }
}

const updateTransactionAndApplySpansForBlockPatchGroup = ({
  patchGroup,
  tx,
  path,
  adapter,
  spans,
  decorations,
}: {
  patchGroup:
    | InsertBlockPatchGroup
    | UpdateBlockPatchGroup
    | UpdateBlockHierarchyPatchGroup
    | UpdateBlockTypeAndAttrsPatchGroup
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  decorations: Decoration[]
}): {
  tx: Transaction
  spans: am.Span[]
  decorations: Decoration[]
  change: {
    start: number
    endA: number
    endB: number
  } | null
} => {
  const newSpans = applyPatchGroupSpans({
    patchGroup,
    initialSpans: spans,
    path,
  })

  const pmDocBefore = tx.doc
  const pmDocAfter = pmDocFromSpans(adapter, newSpans)

  const change = findDiff(pmDocBefore.content, pmDocAfter.content)
  if (change == null) {
    return {
      tx,
      spans: newSpans,
      decorations,
      change: null,
    }
  }

  const updatedTx = tx.replace(
    change.start,
    change.endA,
    pmDocAfter.slice(change.start, change.endB),
  )

  return {
    tx: updatedTx,
    spans: newSpans,
    decorations,
    change,
  }
}

const updateTransactionAndApplySpansForUpdateBlockTypeAndAttrsPatchGroup = ({
  patchGroup,
  tx,
  path,
  adapter,
  spans,
  diffMode,
  decorations,
}: {
  patchGroup: UpdateBlockTypeAndAttrsPatchGroup
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
  decorations: Decoration[]
}): { tx: Transaction; spans: am.Span[]; decorations: Decoration[] } => {
  const {
    tx: updatedTx,
    spans: newSpans,
    change,
  } = updateTransactionAndApplySpansForBlockPatchGroup({
    patchGroup,
    tx,
    path,
    adapter,
    spans,
    decorations,
  })

  const newDecorations =
    diffMode && change
      ? [
          Decoration.inline(change.start, change.endB, {
            class: diffModify,
          }),
        ]
      : []

  return {
    tx: updatedTx,
    spans: newSpans,
    decorations: decorations.concat(newDecorations),
  }
}
