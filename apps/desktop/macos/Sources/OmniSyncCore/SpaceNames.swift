@preconcurrency import StorageSync

/// The folder names of a workspace's teamspaces in Finder, by teamspace id. Each sits beside
/// `My files` and `Shared`, and two names in one folder may not match without case, so a name
/// already taken gets ` (2)`, ` (3)`, … in the order the server lists the teamspaces.
public func teamspaceFolderNames(_ teamspaces: [StorageSyncTeamspace]) -> [String: String] {
    var taken: Set<String> = ["my files", "shared"]
    var names: [String: String] = [:]
    for teamspace in teamspaces {
        var name = teamspace.name
        var n = 2
        while taken.contains(name.lowercased()) {
            name = "\(teamspace.name) (\(n))"
            n += 1
        }
        taken.insert(name.lowercased())
        names[teamspace.id] = name
    }
    return names
}
