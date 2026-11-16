@preconcurrency import StorageSync

/// Pages of a workspace's change feeds, as the working set reports them. A live node is an
/// update; one in Trash (`inTrash`, itself or under a trashed folder) is a deletion, and a
/// restore arrives later as an update.
///
/// A tombstone (`node: null`) is not a deletion yet. Both drives of a workspace share one item
/// identifier per node, and a node moved between `My files` and `Shared` is a tombstone in one
/// feed and an update in the other, in whichever order the drives are read. So an update seen
/// in the same batch wins, and the rest are `unresolved`: look each one up
/// (`GET /sync/:orgId/nodes/:id`) and delete it only on a `404`.
public struct ChangeBatch: Sendable {
    public private(set) var updated: [StorageNode] = []
    public private(set) var deleted: [ItemID] = []
    public private(set) var unresolved: [ItemID] = []

    public init(orgId: String, changes: [StorageSyncChange]) {
        // A node changed twice answers with its last change; a live one beats a tombstone.
        var last: [String: StorageSyncChange] = [:]
        var order: [String] = []
        for change in changes {
            guard let seen = last[change.id] else {
                order.append(change.id)
                last[change.id] = change
                continue
            }
            if change.node != nil || seen.node == nil { last[change.id] = change }
        }
        for id in order {
            guard let change = last[id] else { continue }
            let item = ItemID.node(orgId: orgId, nodeId: id)
            switch (change.node, change.inTrash) {
            case let (node?, false): updated.append(node)
            case (_?, true): deleted.append(item)
            case (nil, _): unresolved.append(item)
            }
        }
    }
}
