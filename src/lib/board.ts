/// Board drop geometry, extracted from TasksBoard so it can be tested.
///
/// The drag library gives us the finalized visual order plus which card
/// moved; the backend needs the card's new NEIGHBOURS, because it computes
/// the sort key from them rather than trusting the frontend with float
/// arithmetic. Getting this wrong puts cards in the wrong place, which is
/// indistinguishable from the persistence bug it replaced.
export interface Neighbours {
  /// The card visually ABOVE the drop slot — smaller sort key. Null at the
  /// top of a lane.
  beforeId: string | null;
  /// The card visually BELOW the drop slot. Null at the bottom of a lane.
  afterId: string | null;
}

export function neighboursFor(
  items: readonly { id: string }[],
  droppedId: string,
): Neighbours {
  const idx = items.findIndex((r) => r.id === droppedId);
  // Not found: report no neighbours rather than guessing. The backend then
  // places the card at the top of the lane, which is wrong but harmless and
  // visible — better than silently seeding from the wrong rows.
  if (idx < 0) return { beforeId: null, afterId: null };
  return {
    beforeId: idx > 0 ? items[idx - 1].id : null,
    afterId: idx < items.length - 1 ? items[idx + 1].id : null,
  };
}
