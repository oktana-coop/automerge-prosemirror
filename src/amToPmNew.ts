import { next as am, Patch, type Prop } from "@automerge/automerge/slim"
import { ResolvedPos, Slice } from "prosemirror-model"
import { Transaction, TextSelection, EditorState } from "prosemirror-state"
import { wrapRangeInList, splitListItem } from "prosemirror-schema-list"
import { amSpliceIdxToPmIdx, pmDocFromSpans } from "./traversal.js"
import { applyPatchToSpans } from "./maintainSpans.js"
import { isPrefixOfArray, isArrayEqual } from "./utils.js"
import { ReplaceStep } from "prosemirror-transform"
import { pmMarksFromAmMarks, SchemaAdapter } from "./schema.js"
import { charPath, patchContentToFragment } from "./amToPm.js"

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

type PatchGroup =
  | SpliceTextPatchGroup
  | DelPatchGroup
  | MarkPatchGroup
  | UnmarkPatchGroup
  | InsertBlockPatchGroup
  | UpdateBlockPatchGroup

const isBlockPatchIndexGroup = (group: Array<Patch>): boolean =>
  group.every(patch => patch.action === "insert" || patch.action === "put")

export default function (
  adapter: SchemaAdapter,
  spans: am.Span[],
  patches: Array<Patch>,
  path: Prop[],
  state: EditorState,
  diffMode = false,
): Transaction {
  const tx = state.tr
  const patchGroups = filterAndGroupPatches(patches, path)

  const result = patchGroups.reduce<{ tx: Transaction; spans: Array<am.Span> }>(
    (acc, patchGroup) => {
      switch (patchGroup.type) {
        case "splice":
          return updateTransactionAndApplySpansForNonBlockPatchGroup({
            tx: acc.tx,
            path,
            adapter,
            spans: acc.spans,
            diffMode,
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
          })({
            patchGroup,
            updateTransactionFromPatchFn: updateTransactionFromDelPatch,
          })
        case "insertBlock":
          return updateTransactionAndApplySpansForInsertBlockGroup({
            patchGroup,
            tx: acc.tx,
            state,
            path,
            adapter,
            spans: acc.spans,
            diffMode,
          })
        default:
          // No update to the ProseMirror transaction but we still update the Automerge spans.
          return {
            tx,
            spans: applyPatchGroupSpans({
              patchGroup,
              initialSpans: acc.spans,
              path,
            }),
          }
      }
    },
    { tx, spans },
  )

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

const filterAndGroupPatches = (
  patches: Array<Patch>,
  path: Prop[],
): Array<PatchGroup> => {
  const pathPatches = patches.filter(patch => isPrefixOfArray(path, patch.path))

  const patchIndexGroups = Object.values(
    Object.groupBy(pathPatches, patch => patch.path[1]),
  ).filter(group => group !== undefined) as am.Patch[][]

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
) => { tx: Transaction; spans: am.Span[] }

const updateTransactionAndApplySpansForNonBlockPatchGroup: UpdateTransactionAndApplySpansForNonBlockPatchGroup =

    ({ tx, path, adapter, spans, diffMode }) =>
    ({ patchGroup, updateTransactionFromPatchFn }) =>
      patchGroup.patches.reduce<{
        tx: Transaction
        spans: Array<am.Span>
      }>(
        (groupAcc, patch) => {
          const updatedTx = updateTransactionFromPatchFn({
            // @ts-expect-error TS cannot infer that the type is correct here according to the group args type
            patch,
            tx: groupAcc.tx,
            path,
            adapter,
            spans: groupAcc.spans,
            diffMode,
          })

          const newSpans = applyPatchToSpans(path, groupAcc.spans, patch)

          return { tx: updatedTx, spans: newSpans }
        },
        { tx, spans },
      )

type UpdateTransactionFromSplicePatchFn = (args: {
  patch: am.SpliceTextPatch
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}) => Transaction

const updateTransactionFromSplicePatch: UpdateTransactionFromSplicePatchFn = ({
  patch,
  tx,
  path,
  adapter,
  spans,
  diffMode,
}) => {
  const index = charPath(path, patch.path)
  if (index === null) return tx
  const pmIdx = amSpliceIdxToPmIdx(adapter, spans, index)
  if (pmIdx == null) throw new Error("Invalid index")
  const content = patchContentToFragment(adapter, patch.value, patch.marks)
  tx = tx.step(new ReplaceStep(pmIdx, pmIdx, new Slice(content, 0, 0)))
  if (diffMode) {
    const diffMark = adapter.schema.marks.diff_insert.create()
    tx = tx.addMark(pmIdx, pmIdx + content.size, diffMark)
  }
  return tx
}

type UpdateTransactionFromMarkPatchFn = (args: {
  patch: am.MarkPatch
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}) => Transaction

const updateTransactionFromMarkPatch: UpdateTransactionFromMarkPatchFn = ({
  patch,
  tx,
  path,
  adapter,
  spans,
  diffMode,
}) => {
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
          const diffMark = adapter.schema.marks.diff_modify.create()
          tx = tx.addMark(pmStart, pmEnd, diffMark)
        }
      } else {
        const pmMarks = pmMarksFromAmMarks(adapter, {
          [mark.name]: mark.value,
        })
        for (const pmMark of pmMarks) {
          tx = tx.addMark(pmStart, pmEnd, pmMark)
          if (diffMode) {
            const diffMark = adapter.schema.marks.diff_modify.create()
            tx = tx.addMark(pmStart, pmEnd, diffMark)
          }
        }
      }
    }
  }
  return tx
}

type UpdateTransactionFromDelPatchFn = (args: {
  patch: am.DelPatch
  tx: Transaction
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}) => Transaction

const updateTransactionFromDelPatch: UpdateTransactionFromDelPatchFn = ({
  patch,
  tx,
  path,
  adapter,
  spans,
  diffMode,
}) => {
  const index = charPath(path, patch.path)
  if (index === null) return tx
  const start = amSpliceIdxToPmIdx(adapter, spans, index)
  if (start == null) throw new Error("Invalid start index in deletion")
  const end = amSpliceIdxToPmIdx(adapter, spans, index + (patch.length || 1))
  if (end == null) throw new Error("Invalid end index in deletion")

  if (diffMode) {
    const diffMark = adapter.schema.marks.diff_delete.create()
    tx = tx.addMark(start, end, diffMark)
  } else {
    tx = tx.delete(start, end)
  }

  return tx
}

const updateTransactionAndApplySpansForInsertBlockGroup = ({
  patchGroup,
  tx,
  state,
  path,
  adapter,
  spans,
}: {
  patchGroup: InsertBlockPatchGroup
  tx: Transaction
  state: EditorState
  path: Prop[]
  adapter: SchemaAdapter
  spans: am.Span[]
  diffMode: boolean
}): { tx: Transaction; spans: am.Span[] } => {
  // Get a copy of patches to avoid mutation.
  // We need to maintain the patches list as-is to properly apply the spans in the end.
  const patches = [...patchGroup.patches]

  const firstPatch = patches.shift()!
  if (firstPatch.action !== "insert") {
    throw new Error(
      "Unexpected patch type in insert block group. The first patch should be an insert patch.",
    )
  }
  const amBlockIndex = firstPatch.path[1]
  if (typeof amBlockIndex !== "number") {
    throw new Error("Could not retrieve block index from insert block group.")
  }

  const blockTypePatch = patches.findLast(
    patch => patch.action === "put" && patch.path[2] === "type",
  )
  if (!blockTypePatch) {
    throw new Error(
      "Could not find block type patch in insert block group. This is required to determine the block type.",
    )
  }
  const blockType = (blockTypePatch as am.PutPatch).value?.toString()

  const pos = amSpliceIdxToPmIdx(adapter, spans, amBlockIndex)
  if (pos == null)
    throw new Error(
      "Invalid ProseMirror index when trying to insert a block from the patch",
    )

  const resolvedPos = tx.doc.resolve(pos)
  const nodeInPos = resolvedPos.nodeAfter
  const nodeBefore = resolvedPos.nodeBefore
  const pmDoc = pmDocFromSpans(adapter, spans)

  switch (blockType) {
    case "paragraph": {
      const node = adapter.schema.nodes.paragraph.create()
      tx = tx.insert(pos, node)
      break
    }
    case "heading": {
      const levelAttrPatch = patches.findLast(
        patch =>
          patch.path.length === 4 &&
          patch.action === "put" &&
          patch.path[2] === "attrs" &&
          patch.path[3] === "level",
      )
      const level = (levelAttrPatch as am.PutPatch).value
      if (typeof level !== "number") {
        throw new Error("Invalid heading level")
      }

      const node = adapter.schema.nodes.heading.create({ level })
      tx = tx.insert(pos, node)
      break
    }
    case "unordered-list-item":
    case "ordered-list-item": {
      const listType =
        blockType === "unordered-list-item" ? "bullet_list" : "ordered_list"
      const listItemType = adapter.schema.nodes.list_item

      if (nodeInPos) {
        addWrapInListToTransaction({
          tx,
          adapter,
          resolvedPos,
          listType: "bullet_list",
        })
      } else {
        if (
          nodeBefore &&
          nodeBefore.type.name === "text" &&
          resolvedPos.node(resolvedPos.depth - 1).type.name === "list_item"
        ) {
          addSplitListItemToTransaction({
            tx,
            state,
            adapter,
            resolvedPos,
          })
        } else {
          // Otherwise, create a new list and insert the list item into it
          const listItem = listItemType.createAndFill()
          if (!listItem) {
            throw new Error("Failed to create list item")
          }
          const listNode = adapter.schema.nodes[listType].createAndFill(
            null,
            listItem,
          )
          if (!listNode) {
            throw new Error(`Failed to create ${listType}`)
          }
          tx = tx.insert(pos, listNode)
        }
      }
      break
    }
    default:
      throw new Error(`Unsupported block type: ${blockType}`)
  }

  return {
    tx,
    spans: applyPatchGroupSpans({
      patchGroup,
      initialSpans: spans,
      path,
    }),
  }
}

const addWrapInListToTransaction = ({
  tx,
  adapter,
  resolvedPos,
  listType,
}: {
  tx: Transaction
  adapter: SchemaAdapter
  resolvedPos: ResolvedPos
  listType: "bullet_list" | "ordered_list"
}) => {
  const range = resolvedPos.blockRange()

  if (!range) {
    throw new Error(`Invalid range at position ${resolvedPos}`)
  }

  tx.setSelection(new TextSelection(resolvedPos))

  if (!wrapRangeInList(tx, range, adapter.schema.nodes[listType])) {
    throw new Error(
      `Failed to wrap position ${resolvedPos} in list of type ${listType}`,
    )
  }

  return tx
}

const addSplitListItemToTransaction = ({
  tx,
  state,
  resolvedPos,
}: {
  tx: Transaction
  state: EditorState
  adapter: SchemaAdapter
  resolvedPos: ResolvedPos
}) => {
  tx.setSelection(new TextSelection(resolvedPos))

  const tempState = EditorState.create({
    doc: tx.doc,
    selection: tx.selection,
    schema: state.schema,
  })

  const success = splitListItem(state.schema.nodes.list_item)(
    tempState,
    splitTx => {
      splitTx.steps.forEach(step => tx.step(step)) // Merge steps into original transaction
    },
  )

  if (!success) {
    throw new Error(`Failed to split list item in position ${resolvedPos.pos}`)
  }

  return tx
}
