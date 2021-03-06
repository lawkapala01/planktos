module.exports = Planktos

const global = typeof window !== 'undefined' ? window : self // eslint-disable-line

// Temp bug fix: https://github.com/srijs/rusha/issues/39
if (global.WorkerGlobalScope) delete global.FileReaderSync

const IdbKvStore = require('idb-kv-store')
const path = require('path')
const parseTorrent = require('parse-torrent-file')
const TabElect = require('tab-elect')
const Snapshot = require('./lib/snapshot')
const Seeder = require('./lib/seeder')

const preCached = [
  '/planktos/planktos.min.js',
  '/planktos/install.js'
]

function Planktos (opts) {
  opts = opts || {}
  this._namespace = opts.namespace != null ? opts.namespace : ''
  this._snapshots = null
  this._snapshotPromise = null
  this._snapshotStore = new IdbKvStore('planktos-snapshots-' + this._namespace)
  this._seeder = null
}

Planktos.prototype.getFile = function (fpath) {
  return this.getAllSnapshots()
  .then(snapshots => {
    if (snapshots.length === 0) throw new Error('No local snapshot. Call planktos.update()')
    return snapshots[snapshots.length - 1].getFile(fpath)
  })
}

Planktos.prototype.fetch = function (req, opts) {
  return this.getAllSnapshots()
  .then(snapshots => {
    if (snapshots.length === 0) throw new Error('No local snapshot. Call planktos.update()')
    return snapshots[snapshots.length - 1].fetch(req, opts)
  })
}

Planktos.prototype.getAllSnapshots = function () {
  let self = this
  if (self._snapshots) return Promise.resolve(self._snapshots)
  if (self._snapshotPromise) return self._snapshotPromise

  self._snapshotPromise = self._snapshotStore.values()
  .then(rawSnapshots => {
    self._snapshotPromise = null
    self._snapshots = []

    for (let i = 0; i < rawSnapshots.length; i++) {
      self._snapshots.push(new Snapshot(rawSnapshots[i], self._namespace))
    }

    return self._snapshots
  })

  return self._snapshotPromise
}

Planktos.prototype.update = function (rootUrl) {
  let self = this
  if (!(rootUrl instanceof URL)) rootUrl = new URL(rootUrl, global.location.origin)

  let torrentMetaUrl = new URL(path.join(rootUrl.pathname, 'planktos/root.torrent'), rootUrl)
  let manifestUrl = new URL(path.join(rootUrl.pathname, 'planktos/manifest.json'), rootUrl)
  let cacheUrls = preCached.map(f => new URL(path.join(rootUrl.pathname, f), rootUrl))

  return Promise.all([
    global.fetch(manifestUrl).then(response => response.json()),
    global.fetch(torrentMetaUrl).then(response => response.arrayBuffer()),
    global.caches.open('planktos-' + self._namespace).then(cache => cache.addAll(cacheUrls))
  ])
  .then(results => {
    let [manifest, torrentMetaBuffer] = results
    return self._add(manifest, torrentMetaBuffer, rootUrl)
  })
}

Planktos.prototype._add = function (manifest, torrentMetaBuffer, rootUrl) {
  let self = this
  return self.getAllSnapshots().then(() => { // Ensure self._snapshots is initialized
    return new Promise(function (resolve, reject) {
      let transaction = self._snapshotStore.transaction()
      transaction.values(function (err, rawSnapshots) {
        if (err) return reject(err)
        let hash = parseTorrent(new Buffer(torrentMetaBuffer)).infoHash
        let snapshot = self._snapshots.find(s => s.hash === hash)
        if (snapshot) return snapshot

        let rawSnapshot = rawSnapshots.find(s => s.hash === hash)
        let alreadyExists = rawSnapshot != null

        if (!alreadyExists) {
          rawSnapshot = {
            manifest: manifest,
            torrentMetaBuffer: torrentMetaBuffer,
            rootUrl: rootUrl.toString(),
            hash: hash
          }
        }

        snapshot = new Snapshot(rawSnapshot, self._namespace)
        self._snapshots.push(snapshot)
        if (self._seeder) self._seeder.add(snapshot)

        resolve(alreadyExists ? snapshot : transaction.add(rawSnapshot).then(() => snapshot))
      })
    })
  })
}

Planktos.prototype.removeSnapshot = function (hash) {
  let self = this
  return self.getAllSnapshots().then(() => { // Ensure self._snapshots is initialized
    let index = self._snapshots.findIndex(s => s.hash === hash)
    if (index !== -1) {
      self._snapshots[index].destroy()
      self._snapshots.splice(index, 1) // Delete snapshot at `index`
      if (self._seeder) self._seeder.remove(hash)
    }
    return new Promise(function (resolve, reject) {
      let transaction = self._snapshotStore.transaction()
      transaction.json(function (err, rawSnapshots) {
        if (err) return reject(err)
        let key = Object.keys(rawSnapshots).find(k => rawSnapshots[k].hash === hash)
        resolve(key == null ? undefined : transaction.remove(key))
      })
    })
  })
}

Planktos.prototype.startSeeder = function () {
  let self = this
  if (self._seeder) return self._seeder
  self._seeder = new Seeder()

  let tabElect = new TabElect('planktos')
  tabElect.on('elected', self._seeder.start.bind(self._seeder))
  tabElect.on('deposed', self._seeder.stop.bind(self._seeder))

  self._snapshotStore.on('add', function (change) {
    self._seeder.add(new Snapshot(change.value, self._namespace))
  })

  self._snapshotStore.values().then(rawSnapshots => {
    rawSnapshots.forEach(s => self._seeder.add(new Snapshot(s, self._namespace)))
  })

  return self._seeder
}
