import { serialize, observe, action, compute, files, autorun, ceramic, keypath, history, uuid, db, git, realtime, serializeModel, Model, Room, Peer } from 'utils';
import Scene from './Scene';
import SceneItem from './SceneItem';
import UiState from './UiState';
import * as fs from 'fs';
import * as electron from 'electron';
import * as os from 'os';
import shortcuts from 'app/shortcuts';
import { join, normalize, dirname, relative, basename, isAbsolute } from 'path';
import { context } from 'app/context';
import { user } from './index';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { ncp } from 'ncp';
import rimraf from 'rimraf';
import dateformat from 'dateformat';

interface PeerMessage {

    /** The (unique) index of this message. Allows clients to keep strict message orders. */
    index:number;

    /** Message type */
    type:string;

    /** Message data */
    data?:any;

} //PeerMessage

interface PendingPeerMessage {

    /** The message itself */
    message:PeerMessage;

    /** Time when the message was sent */
    time:number;

    /** Number of attempts. When this number gets too high,
        we discard the message (all messages for this client)
        and mark the client as `expired`. In case the client reconnects later,
        He will have to make itself `up to date` before exchanging changesets. */
    attempts:number;

} //PendingPeerMessage

interface PeerMessageReceipt {

    /** Always to `true`, to identify receipt kinds */
    receipt:true;

    /** The message index we want to confirm its reception. */
    index:number;

} //PeerMessageReceipt

class Project extends Model {

/// Properties

    /** Project hash (unique identifier) */
    @observe @serialize uuid:string;

    /** Project save timestamp */
    @observe @serialize saveTimestamp:number;

    /** Project scenes */
    @observe @serialize(Scene) scenes:Array<Scene> = [];

    /** Default scene bundle (name) */
    @observe @serialize defaultSceneBundle:string = null;

    /** Custom scene bundles (name) */
    @observe @serialize sceneBundles:Array<string> = [];

    /** Project error */
    @observe error?:string;

    /** Project name */
    @observe @serialize name?:string;

    /** Project footprint.
        The footprint is computed from local project's path and host machine identifier. */
    @observe @serialize footprint:string;

/// Editor canvas

    /** Project custom editor canvas path */
    @observe @serialize editorPath?:string;

/// Git (Github) repository

    /** Whether the editor is currently syncing with Github repository. */
    @observe syncingWithGithub:boolean = false;

    /** Whether the editor is currently syncing with Github repository. */
    @observe @serialize lastGithubSyncStatus:'success'|'failure' = null;

    /** Git repository (https) URL */
    @observe @serialize gitRepository?:string;

    /** Keep the (unix) timestamp of when this project was last synced with Github. */
    @observe @serialize lastGitSyncTimestamp?:number;

    /** Keep last git sync footprint. */
    @observe @serialize lastGitSyncProjectFootprint?:string;

/// Realtime / Online

    @observe @serialize onlineEnabled:boolean = false;

    /** A flag that marks realtime as broken */
    @observe realtimeBroken:boolean = false;

    /** Our own client id. Generated at app startup. */
    @observe clientId:string = uuid();

    /** The room where every client/peer is connecting to. It's id is the same as the project's uuid. */
    @observe room:Room = null;

    /** List of connected peers (`us` is not included in this list) */
    @observe peers:Array<Peer> = [];

    /** Is `true` if current project data is considered up to date.
        Project must be up to date before sending data to other peers. */
    @observe isUpToDate:boolean = false;

    /** Last master step index we processed. Coupled with local step index,
        helps to know what is the gap (if any) with master. */
    @observe masterStepIndex:number = null;

    /** Current local step index. Coupled with last master step index,
        helps to know what is the gap (if any) with master. */
    @observe localStepIndex:number = null;

    /** Whether the realtime (realtime.co) connetion itself is ready. */
    @observe realtimeConnected:boolean = false;

    /** Track the last index of message processed for each peer (client id) */
    @observe lastProcessedIndexByClientId:Map<string,number> = new Map();

    /** Keep received messages for each peer (client id) until they are processed */
    @observe receivedMessagesByClientId:Map<string,Map<number,PeerMessage>> = new Map();

    /** Track the last index of message sent to each peer (client id) */
    @observe lastSentIndexByClientId:Map<string,number> = new Map();

    /** Keep sent messages for each peer (client id) until we get a receipt from remote peer */
    @observe pendingMessagesByClientId:Map<string,Map<number,PendingPeerMessage>> = new Map();

    /** Expired client ids. At this stage, we don't interact with them,
        unless we get them up to date again. */
    @observe expiredClientIds:Map<string,boolean> = new Map();

/// UI State

    @observe @serialize ui:UiState;

/// Assets

    /** Updating this value will force refresh of assets list */
    @observe assetsUpdatedAt:number;

    /** Sometimes, we want to lock assets lists, like when loading a project to prevent
        it from processing in-between values that don't make any sense. */
    @observe assetsLocked:boolean = false;

    /** Assets path */
    @observe @serialize assetsPath?:string;

    /** All assets */
    @observe allAssets?:Array<string>;

    /** All asset directories */
    @observe allAssetDirs?:Array<string>;

    /** All assets by name */
    @observe allAssetsByName?:Map<string, Array<string>>;

    /** All asset directories */
    @observe allAssetDirsByName?:Map<string, Array<string>>;

    /** Image assets */
    @observe imageAssets?:Array<{name:string, constName:string, paths:Array<string>}>;

    /** Text assets */
    @observe textAssets?:Array<{name:string, constName:string, paths:Array<string>}>;

    /** Sound assets */
    @observe soundAssets?:Array<{name:string, constName:string, paths:Array<string>}>;

    /** Font assets */
    @observe fontAssets?:Array<{name:string, constName:string, paths:Array<string>}>;

/// Computed

    @compute get path():string {
        
        return user.projectPath;

    } //path

    @compute get initialized():boolean {
        
        return !!this.name;

    } //initialized

    @compute get absoluteAssetsPath():string {

        let path = this.assetsPath;

        if (!path) return null;

        if (isAbsolute(path)) return path;

        if (!this.path) {
            return null;
        }
        else {
            return normalize(join(dirname(this.path), path));
        }

    } //absoluteAssetsPath
    
    @compute get absoluteEditorPath():string {

        let path = this.editorPath;

        if (!path) return null;

        if (isAbsolute(path)) return path;

        if (!this.path) {
            return null;
        }
        else {
            return normalize(join(dirname(this.path), path));
        }

    } //absoluteEditorPath
    
    @compute get hasValidEditorPath():boolean {

        let path = this.absoluteEditorPath;

        // TODO

        return false;

    } //hasValidEditorPath

    @compute get cwd():string {

        if (this.path) return dirname(this.path);
        return null;

    } //cwd

/// Lifecycle

    constructor(id?:string) {

        super(id);

        // Bind realtime features
        this.bindRealtime();

        // Update status bar text
        //
        autorun(() => {

            if (!this.ui) return;

            let CtlrOrCmd = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
            
            if (this.gitRepository) {
                if (!user.githubToken) {
                    this.ui.statusBarTextKind = 'warning';
                    this.ui.statusBarText = '⚠ Set your Github Personal Access Token in settings';
                }
                else if (this.syncingWithGithub) {
                    this.ui.statusBarTextKind = 'default';
                    this.ui.statusBarText = 'Synchronizing with Github repository \u2026';
                }
                else if (this.lastGithubSyncStatus === 'failure') {
                    this.ui.statusBarTextKind = 'failure';
                    this.ui.statusBarText = '✗ Failed to synchronize with Github';
                }
                else if (user.githubProjectDirty) {
                    this.ui.statusBarTextKind = 'default';
                    this.ui.statusBarText = 'Press ' + CtlrOrCmd + '+Alt+S to synchronize with Github';
                }
                else if (this.lastGithubSyncStatus === 'success') {
                    this.ui.statusBarTextKind = 'success';
                    this.ui.statusBarText = '✔ Synchronized with Github on ' + dateformat(this.lastGitSyncTimestamp * 1000);
                }
                else {
                    this.ui.statusBarTextKind = 'default';
                    this.ui.statusBarText = '';
                }
            }
            else {
                this.ui.statusBarTextKind = 'default';
                this.ui.statusBarText = '';
            }

        });

        // Generate project footprint
        //
        autorun(() => {

            let projectPath = this.path;
            let machineId = context.machineId;

            if (!projectPath) return;
            if (!machineId) return;

            let hash = createHash('md5').update(projectPath + ' ~! ' + machineId).digest('hex');
            this.footprint = hash;

        });

        // Update asset info from assets path
        //
        autorun(() => {

            let updatedAt = this.assetsUpdatedAt;
            let electronApp = electron.remote.require('./app.js');

            if (this.assetsLocked) {
                electronApp.processingAssets = true;
                return;
            }

            electronApp.sourceAssetsPath = this.absoluteAssetsPath;
            electronApp.assetsPath = null;

            if (this.absoluteAssetsPath != null) {
                electronApp.processingAssets = true;
                let processedAssetsPath = join(os.tmpdir(), 'ceramic', this.id);
                let proc = ceramic.run([
                    'luxe', 'assets', 'web',
                    '--from', this.absoluteAssetsPath,
                    '--to', processedAssetsPath
                ], process.cwd(), (code, out, err) => {
                    if (code !== 0) {
                        console.error('Failed to process assets from ' + this.absoluteAssetsPath + ' to ' + processedAssetsPath + ' : ' + err);
                    }
                    else {
                        electronApp.assetsPath = processedAssetsPath;
                        electronApp.processingAssets = false;
                        console.log('assets path: ' + electronApp.assetsPath);
                    }
                });
            }

            if (!this.absoluteAssetsPath || !fs.existsSync(this.absoluteAssetsPath) || !fs.statSync(this.absoluteAssetsPath).isDirectory()) {
                this.imageAssets = null;
                this.textAssets = null;
                this.soundAssets = null;
                this.fontAssets = null;
                this.allAssets = null;
                this.allAssetDirs = null;
                this.allAssetsByName = null;
                this.allAssetDirsByName = null;
                return;
            }

            if (!context.ceramicReady) {
                this.imageAssets = [];
                this.textAssets = [];
                this.soundAssets = [];
                this.fontAssets = [];
                this.allAssets = [];
                this.allAssetDirs = [];
                this.allAssetsByName = new Map();
                this.allAssetDirsByName = new Map();
                return;
            }

            let rawList = files.getFlatDirectory(this.absoluteAssetsPath);

            ceramic.send({
                type: 'assets/lists',
                value: {
                    list: rawList
                }
            }, (message) => {
                
                this.imageAssets = message.value.images;
                this.textAssets = message.value.texts;
                this.soundAssets = message.value.sounds;
                this.fontAssets = message.value.fonts;

                this.allAssets = message.value.all;
                this.allAssetDirs = message.value.allDirs;

                this.allAssetsByName = new Map();
                for (let key in message.value.allByName) {
                    if (message.value.allByName.hasOwnProperty(key)) {
                        this.allAssetsByName.set(key, message.value.allByName[key]);
                    }
                }

                this.allAssetDirsByName = new Map();
                for (let key in message.value.allDirsByName) {
                    if (message.value.allDirsByName.hasOwnProperty(key)) {
                        this.allAssetDirsByName.set(key, message.value.allDirsByName[key]);
                    }
                }

            });

        });

        // Deselect item when changing scene tab
        autorun(() => {

            if (this.ui == null) return;
            if (this.ui.editor !== 'scene') return;
            if (this.ui.sceneTab !== 'visuals') {
                ceramic.send({
                    type: 'scene-item/select',
                    value: null
                });
            }

        });

        // Update data from ceramic (haxe)
        ceramic.listen('set/*', (message) => {

            let [, key] = message.type.split('/');

            // Change UI
            if (key.startsWith('ui.')) {
                keypath.set(this.ui, key.substr(3), message.value);
            }
            // Change Scene Item
            else if (key.startsWith('scene.item.')) {
                if (this.ui.selectedScene == null || this.ui.selectedScene.items == null) return;

                let itemId = key.substr(11);
                let item = this.ui.selectedScene.itemsById.get(itemId);

                if (item != null) {
                    for (let k in message.value) {
                        if (message.value.hasOwnProperty(k)) {
                            keypath.set(item, k, message.value[k]);
                        }
                    }
                }
            }

        });

    } //constructor

/// Public API

    @action createNew() {

        // Set name
        this.name = null;

        // Set unique identifier
        this.uuid = uuid();

        // Reset assets path
        this.assetsPath = null;

        // Reset project path
        user.projectPath = null;

        // Reset editor path
        this.editorPath = null;

        // Reset git stuff
        this.gitRepository = null;
        this.lastGitSyncProjectFootprint = null;
        this.lastGitSyncTimestamp = null;
        this.lastGithubSyncStatus = null;

        // Save timestamp
        this.saveTimestamp = null;

        // Scene bundles
        this.defaultSceneBundle = null;
        this.sceneBundles = [];

        // Set scene
        this.scenes = [];

        // Set UI state
        this.ui = new UiState('ui');

    } //createNew

    @action chooseAssetsPath() {

        let path = files.chooseDirectory();
        if (path != null) {
            this.setAssetsPath(path);
        }

    } //chooseAssetsPath

    @action setAssetsPath(path:string) {

        let projectDir = this.path ? normalize(dirname(this.path)) : null;
        let assetsDir = normalize(path);
        
        if (projectDir === assetsDir) {
            this.assetsPath = '.';
        }
        else if (projectDir) {
            let res = relative(projectDir, assetsDir);
            if (!res.startsWith('.')) res = './' + res;
            this.assetsPath = res;
        }
        else {
            this.assetsPath = path;
        }

    }

    @action setEditorPath(path:string) {
        
        if (path) {

            // Set project dir
            //
            let projectDir = normalize(dirname(this.path));
            let editorDir = normalize(path);
            
            if (projectDir === editorDir) {
                this.editorPath = '.';
            } else {
                let res = relative(projectDir, editorDir);
                if (!res.startsWith('.')) res = './' + res;
                this.editorPath = res;
            }
            
        }
        else {
            this.editorPath = null;
        }

    } //chooseAssetsPath

    @action createScene() {

        let scene = new Scene();
        scene.name = 'Scene ' + (this.scenes.length + 1);

        this.scenes.push(scene);
        this.ui.selectedSceneId = scene.id;

    } //createScene

    @action removeCurrentSceneItem() {

        let itemId = this.ui.selectedItemId;
        if (!itemId) return;

        let item = this.ui.selectedScene.itemsById.get(itemId);

        if (item != null) {

            if (this.ui.selectedItemId === itemId) {
                this.ui.selectedItemId = null;
            }

            this.ui.selectedScene.items.splice(
                this.ui.selectedScene.items.indexOf(item),
                1
            );
            item = null;
        }

    } //removeCurrentSceneItem

    @action removeCurrentScene() {

        let sceneId = this.ui.selectedSceneId;

        if (!sceneId) return;

        let index = -1;
        let i = 0;
        for (let scene of this.scenes) {
            if (scene.id === sceneId) {
                index = i;
                break;
            }
            i++;
        }

        if (index !== -1) {
            this.ui.selectedSceneId = null;
            this.scenes.splice(index, 1);
        }

    } //removeCurrentScene

/// Save/Open

    open():void {

        let path = files.chooseFile(
            'Open project',
            [
                {
                    name: 'Ceramic Project File',
                    extensions: ['ceramic']
                }
            ]
        );

        if (!path) return;

        this.openFile(path);

    } //open

    openFile(path:string):void {

        console.log('open project: ' + path);

        // Lock assets
        this.assetsLocked = true;

        try {
            let data = JSON.parse(''+fs.readFileSync(path));
            
            let serialized = data.project;

            // Remove footprint (we will compute ours)
            delete serialized.footprint;

            // Reset sync timestamp & footprint if not provided
            if (!serialized.lastGitSyncProjectFootprint) {
                serialized.lastGitSyncProjectFootprint = null;
            }
            if (!serialized.lastGitSyncTimestamp) {
                serialized.lastGitSyncTimestamp = null;
            }

            // Update db from project data
            for (let serializedItem of data.entries) {
                db.putSerialized(serializedItem);
            }

            // Put project (and trigger its update)
            db.putSerialized(serialized);

            // Update project path
            user.projectPath = path;

            // Unlock and force assets to reload
            this.assetsUpdatedAt = new Date().getTime();
            this.assetsLocked = false;

            // Mark project as clean
            user.markProjectAsClean();

        }
        catch (e) {
            alert('Failed to open project: ' + e);

            // Unlock assets
            this.assetsLocked = false;
        }
    }

    save():void {

        if (!this.path || !fs.existsSync(dirname(this.path))) {
            this.saveAs();
            return;
        }

        // Update save timestamp
        this.saveTimestamp = Math.round(new Date().getTime() / 1000.0);

        // Serialize
        let options = { entries: {}, recursive: true };
        let serialized = serializeModel(this, options);

        // Keep the stuff we want
        //
        let entries:Array<any> = [];
        for (let key in options.entries) {
            if (options.entries.hasOwnProperty(key)) {
                entries.push(options.entries[key].serialized);
            }
        }
        
        let data = JSON.stringify({
            project: serialized,
            entries: entries
        }, null, 2);

        // Save data
        fs.writeFileSync(this.path, data);
        console.log('saved project: ' + this.path);

        // Mark project as `clean`
        user.markProjectAsClean();

    } //save

    saveAs():void {

        let path = files.chooseSaveAs(
            'Save project',
            [
                {
                    name: 'Ceramic Project File',
                    extensions: ['ceramic']
                }
            ],
            this.path ? this.path : undefined
        );

        if (path) {

            // Keep current absolute assets path
            let assetsPath = this.absoluteAssetsPath;

            // Keep current absolut editor path
            let editorPath = this.absoluteEditorPath;

            // Update project path
            user.projectPath = path;

            // Update assets path (make it relative to new project path)
            if (assetsPath) {
                this.setAssetsPath(assetsPath);
            }

            // Update editor path as well
            if (editorPath) {
                this.setEditorPath(editorPath);
            }

            // Set project name from file path
            this.name = basename(path).split('.')[0];

            // Set project default scene bundle from project name
            this.defaultSceneBundle = this.name.split(' ').join('_');

            // Save
            this.save();
        }

    } //saveAs

/// Clipboard

    copySelectedSceneItem(cut:boolean = false):string {

        let scene = this.ui.selectedScene;
        if (!scene) return null;

        // Get scene item
        let item = this.ui.selectedItem;
        if (!item) return null;

        // Duplicate serialized data
        let data = JSON.parse(JSON.stringify(db.getSerialized(item.id)));

        // Cut?
        if (cut) {
            let index = scene.items.indexOf(item);
            if (index !== -1) {
                scene.items.splice(index, 1);
            }
        }

        return JSON.stringify(data);

    } //copySelectedItem

    pasteSceneItem(strData:string) {

        let scene = this.ui.selectedScene;
        if (!scene) return;

        // Parse data
        let data = JSON.parse(strData);

        // Create a new id
        data.id = uuid();

        // Update name
        if (data.name != null && !data.name.endsWith(' (copy)')) {
            data.name += ' (copy)';
        }

        // Put item in db
        db.putSerialized(data);

        // Create instance
        let item = db.getOrCreate(Model, data.id) as SceneItem;

        // Add item
        scene.items.push(item);

        // Select item
        this.ui.selectedItemId = item.id;

    } //copySelectedItem

/// Drag & Drop files

    dropFile(path:string):void {

        if (path.endsWith('.ceramic')) {
            this.openFile(path);
        }

    } //dropFile

/// Build

    /** Build/Export scene files */
    build():void {

        if (!this.absoluteAssetsPath) {
            alert('You choose an asset directory before building.');
            return;
        }

        if (!fs.existsSync(this.absoluteAssetsPath)) {
            alert('Current assets directory doesn\'t exist');
            return;
        }

        let perBundle:Map<string,any> = new Map();

        // Serialize each scene
        for (let scene of this.scenes) {

            let sceneData = scene.serializeForCeramic();

            // Include scene items
            sceneData.items = [];
            for (let item of scene.items) {
                let serialized = item.serializeForCeramic();
                sceneData.items.push(serialized);
            }

            let bundleName = scene.bundle ? scene.bundle : this.defaultSceneBundle;
            if (bundleName) {
                let bundleData:any = perBundle.get(bundleName);
                if (bundleData == null) {
                    bundleData = {};
                    perBundle.set(bundleName, bundleData);
                }
                bundleData[scene.id] = sceneData;
            }
            else {
                alert('Save project before building it.');
                return;
            }

        }

        perBundle.forEach((val, key) => {

            let scenesPath = join(this.absoluteAssetsPath, key + '.scenes');
            let scenesData = JSON.stringify(val, null, 2);
            
            console.log('Export: ' + scenesPath);

            fs.writeFileSync(scenesPath, scenesData);

        });

    } //build

/// Remote save

    syncWithGithub(resetToGithub:boolean = false, auto:boolean = false):void {

        if (this.syncingWithGithub) return;

        if (!context.gitVersion) {
            alert('Git is required to save remotely to Github.');
            return;
        }

        if (!user.githubToken) {
            alert('You need to set a Github Personal Access Token.');
            return;
        }

        // Compute 'tokenized' git url
        if (!this.gitRepository || !this.gitRepository.startsWith('https://')) {
            alert('Invalid git repository URL.');
            return;
        }

        // Save local version before sync
        this.save();

        // Check that project is saved to disk and has local path
        if (!this.path) {
            alert('Cannot synchronize project with Github if it\'s not saved to disk first');
            return;
        }

        this.syncingWithGithub = true;
        if (!auto) this.ui.loadingMessage = 'Fetching remote repository \u2026';

        // Serialize
        let options = { entries: {}, recursive: true };
        let serialized = serializeModel(this, options);

        // Remove things we don't want to save remotely
        delete serialized.lastGitSyncTimestamp;
        delete serialized.lastGithubSyncStatus;
        delete serialized.lastGitSyncProjectFootprint;

        // Keep the stuff we want
        //
        let entries:Array<any> = [];
        for (let key in options.entries) {
            if (options.entries.hasOwnProperty(key)) {
                entries.push(options.entries[key].serialized);
            }
        }
        
        let data = JSON.stringify({
            project: serialized,
            entries: entries
        }, null, 2);

        // Clone repository
        //
        let tmpDir = join(os.tmpdir(), 'ceramic');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir);
        }

        let uniqId = uuid();
        let repoDir = join(tmpDir, uniqId);
        let localAssetsPath = this.absoluteAssetsPath;

        let authenticatedUrl = 'https://' + user.githubToken + '@' + this.gitRepository.substr('https://'.length);

        // TODO optimize?
        // Ideally, this could be optimized so that we don't have to pull the whole data set of repo's latest commit.
        // In practice, as we are already doing a shallow clone (only getting latest commit), it should be OK.
        // Things can be kept simpler as we never need to keep a permanent local git repository.

        // Clone (shallow, only latest commit)
        git.run(['clone', '--depth', '1', authenticatedUrl, uniqId], tmpDir, (code, out, err) => {
            if (code !== 0) {
                this.syncingWithGithub = false;
                this.lastGithubSyncStatus = 'failure';
                this.ui.loadingMessage = null;
                if (!auto) alert('Failed to pull latest commit: ' + (''+err).split(user.githubToken + '@').join(''));
                rimraf.sync(repoDir);
                return;
            }
            
            // Get latest commit timestamp
            git.run(['log', '-1', '--pretty=format:%ct'], repoDir, (code, out, err) => {
                if (code !== 0) {
                    this.syncingWithGithub = false;
                    this.lastGithubSyncStatus = 'failure';
                    this.ui.loadingMessage = null;
                    if (!auto) alert('Failed to get latest commit timestamp: ' + (''+err).split(user.githubToken + '@').join(''));
                    rimraf.sync(repoDir);
                    return;
                }

                let timestamp = parseInt(out, 10);
                let hasProjectInRepo = fs.existsSync(join(repoDir, 'project.ceramic'));
                this.ui.loadingMessage = null;

                if (resetToGithub || (hasProjectInRepo && (this.footprint !== this.lastGitSyncProjectFootprint || !this.lastGitSyncTimestamp))) {
                    // Apply remote version
                    this.applyRemoteGitToLocal(repoDir, localAssetsPath, timestamp, auto);
                }
                else if (hasProjectInRepo && timestamp > this.lastGitSyncTimestamp) {

                    if (auto) {
                        // Always get most recent changes in automatic mode
                    }
                    else {
                        // There are more recent commits from remote.
                        // Prompt user to know which version he wants to keep (local or remote)
                        this.promptChoice({
                                title: "Resolve conflict",
                                message: "Remote project has new changes.\nWhich version do you want to keep?",
                                choices: [
                                    "Local",
                                    "Remote"
                                ]
                            },
                            (result) => {
                                
                                if (result === 0) {
                                    // Apply local version
                                    this.applyLocalToRemoteGit(repoDir, data, localAssetsPath, auto);
                                }
                                else if (result === 1) {
                                    // Apply remote version
                                    this.applyRemoteGitToLocal(repoDir, localAssetsPath, timestamp, auto);
                                }
                            }
                        );
                    }
                }
                else {
                    // Apply local version
                    this.applyLocalToRemoteGit(repoDir, data, localAssetsPath, auto);
                }

            });
            
        });

    } //syncWithGithub

    applyLocalToRemoteGit(repoDir:string, data:string, localAssetsPath:string, autoSave:boolean, commitMessage?:string) {

        if (!commitMessage) {
            this.promptText({
                title: 'Commit message',
                message: 'Please describe your changes:',
                placeholder: 'Enter a message\u2026',
                validate: 'Commit',
                cancel: 'Cancel'
            },
            (result) => {
                if (result == null) {
                    // Canceled
                    this.syncingWithGithub = false;
                    this.lastGithubSyncStatus = null;
                    this.ui.loadingMessage = null;
                    rimraf.sync(repoDir);
                    return;
                }

                this.applyLocalToRemoteGit(repoDir, data, localAssetsPath, autoSave, result);
            });

            return;
        }

        if (!autoSave) this.ui.loadingMessage = 'Pushing changes \u2026';

        // Sync assets
        if (localAssetsPath) {
            let repoAssetsDir = join(repoDir, 'assets');

            // Copy local assets to repo assets
            if (fs.existsSync(repoAssetsDir)) {
                rimraf.sync(repoAssetsDir);
            }
            fs.mkdirSync(repoAssetsDir);
            ncp(localAssetsPath, repoAssetsDir, (err) => {
                if (err) {
                    this.syncingWithGithub = false;
                    this.lastGithubSyncStatus = 'failure';
                    this.ui.loadingMessage = null;
                    alert('Failed to copy asset: ' + err);
                    rimraf.sync(repoDir);
                    return;
                }

                syncProjectFileAndPush();
            });
        }
        else {
            setImmediate(() => {
                syncProjectFileAndPush();
            });
        }

        // Set .gitignore
        let gitIgnorePath = join(repoDir, '.gitignore');
        fs.writeFileSync(gitIgnorePath, [
            '.DS_Store',
            '__MACOSX',
            'thumbs.db'
        ].join(os.EOL));

        // Sync project file
        let syncProjectFileAndPush = () => {
            let repoProjectFile = join(repoDir, 'project.ceramic');
            fs.writeFileSync(repoProjectFile, data);

            // Stage files
            git.run(['add', '-A'], repoDir, (code, out, err) => {
                if (code !== 0) {
                    this.syncingWithGithub = false;
                    this.lastGithubSyncStatus = 'failure';
                    this.ui.loadingMessage = null;
                    alert('Failed to stage modified files: ' + (''+err).split(user.githubToken + '@').join(''));
                    rimraf.sync(repoDir);
                    return;
                }

                // Commit
                git.run(['commit', '-m', commitMessage], repoDir, (code, out, err) => {
                    if (code !== 0) {
                        this.syncingWithGithub = false;
                        this.lastGithubSyncStatus = 'failure';
                        this.ui.loadingMessage = null;
                        alert('Failed commit changes: ' + (''+err).split(user.githubToken + '@').join(''));
                        rimraf.sync(repoDir);
                        return;
                    }

                    // Get commit timestamp
                    git.run(['log', '-1', '--pretty=format:%ct'], repoDir, (code, out, err) => {
                        if (code !== 0) {
                            this.syncingWithGithub = false;
                            this.lastGithubSyncStatus = 'failure';
                            this.ui.loadingMessage = null;
                            alert('Failed to get new commit timestamp: ' + (''+err).split(user.githubToken + '@').join(''));
                            rimraf.sync(repoDir);
                            return;
                        }

                        // Keep timestamp
                        let timestamp = parseInt(out, 10);

                        // Push
                        git.run(['push'], repoDir, (code, out, err) => {
                            if (code !== 0) {
                                this.syncingWithGithub = false;
                                this.lastGithubSyncStatus = 'failure';
                                this.ui.loadingMessage = null;
                                alert('Failed to push to remote repository: ' + (''+err).split(user.githubToken + '@').join(''));
                                rimraf.sync(repoDir);
                                return;
                            }

                            // Save project with new timestamp and footprint
                            this.lastGitSyncTimestamp = timestamp;
                            this.lastGitSyncProjectFootprint = this.footprint;
                            this.save();
                            
                            // Finish
                            this.syncingWithGithub = false;
                            rimraf.sync(repoDir);
                            this.lastGithubSyncStatus = 'success';
                            this.ui.loadingMessage = null;
                            user.markGithubProjectAsClean();
                        });
                    });
                });
            });
        };

    } //applyLocalToRemoteGit

    applyRemoteGitToLocal(repoDir:string, prevAssetsPath:string, commitTimestamp:number, autoLoad:boolean) {

        if (!autoLoad) this.ui.loadingMessage = 'Updating local files \u2026';

        // Lock assets
        this.assetsLocked = true;

        // Get remote project data
        let repoProjectFile = join(repoDir, 'project.ceramic');
        let data = JSON.parse('' + fs.readFileSync(repoProjectFile));

        // Assign new data
        let serialized = data.project;

        // Remove footprint (we will compute ours)
        delete serialized.footprint;

        // Remove assets path (if current already set)
        if (prevAssetsPath) {
            delete serialized.assetsPath;
        }

        // Update db from project data
        for (let serializedItem of data.entries) {
            db.putSerialized(serializedItem);
        }

        // Put project (and trigger its update)
        db.putSerialized(serialized);

        // Get new assets path
        let localAssetsPath = this.absoluteAssetsPath;

        // Sync assets
        if (localAssetsPath) {
            let repoAssetsDir = join(repoDir, 'assets');

            try {
                // Copy local assets to repo assets
                if (fs.existsSync(localAssetsPath)) {
                    rimraf.sync(localAssetsPath);
                }
                fs.mkdirSync(localAssetsPath);
            } catch (e) {
                this.syncingWithGithub = false;
                this.lastGithubSyncStatus = 'failure';
                this.ui.loadingMessage = null;

                // Unlock assets
                this.assetsLocked = true;

                console.error(e);
                alert('Failed to update asset directory: ' + e);
                return;
            }
            if (fs.existsSync(repoAssetsDir)) {
                ncp(repoAssetsDir, localAssetsPath, (err) => {
                    if (err) {
                        this.syncingWithGithub = false;
                        this.lastGithubSyncStatus = 'failure';
                        this.ui.loadingMessage = null;

                        // Unlock assets
                        this.assetsLocked = true;

                        alert('Failed to copy asset: ' + err);
                        rimraf.sync(repoDir);
                        return;
                    }

                    finish();
                });
            } else {
                setImmediate(() => {
                    finish();
                });
            }
        }
        else {
            setImmediate(() => {
                finish();
            });
        }

        // That's it
        let finish = () => {

            // Save project with changed data and new timestamp and footprint
            this.lastGitSyncTimestamp = commitTimestamp;
            this.lastGitSyncProjectFootprint = this.footprint;
            this.save();

            this.syncingWithGithub = false;
            this.lastGithubSyncStatus = 'success';
            this.ui.loadingMessage = null;
            user.markGithubProjectAsClean();
            rimraf.sync(repoDir);
            
            // Unlock and force assets list to update
            this.assetsUpdatedAt = new Date().getTime();
            this.assetsLocked = true;
        };

    } //applyRemoteGitToLocal

/// Prompt

    promptChoice(options:{title:string, message:string, choices:Array<string>}, callback:(result:number) => void) {

        this.ui.promptChoiceResult = null;

        let release:any = null;
        release = autorun(() => {
            if (this.ui.promptChoiceResult == null) return;
            release();
            let result = this.ui.promptChoiceResult;
            this.ui.promptChoiceResult = null;
            callback(result);
        });

        this.ui.promptChoice = options;

    } //promptChoice

    promptText(options:{title:string, message:string, placeholder:string, validate:string, cancel?:string}, callback:(result:string) => void) {

        this.ui.promptTextResult = null;
        this.ui.promptTextCanceled = false;

        let release:any = null;
        release = autorun(() => {
            if (this.ui.promptTextCanceled) {
                release();
                callback(null);
                return;
            }
            if (this.ui.promptTextResult == null) return;
            release();
            let result = this.ui.promptTextResult;
            this.ui.promptTextResult = null;
            callback(result);
        });

        this.ui.promptText = options;

    } //promptText

/// Realtime

    @compute get shouldSendToMaster():boolean {

        return this.hasRemotePeers && !this.isMaster && this.isUpToDate;

    } //shouldSendToMaster

    @compute get hasRemotePeers():boolean {

        return this.peers != null && this.peers.length > 0;

    } //hasRemotePeers

    @compute get isMaster():boolean {

        return !this.hasRemotePeers || this.masterPeer == null;

    } //isMaster

    @compute get masterPeer():Peer {

        if (!this.hasRemotePeers) {
            return null;
        }
        else {
            let ids = [this.clientId];
            for (let peer of this.peers) {
                ids.push(peer.remoteClient);
            }
            ids.sort();
            if (ids[0] === this.clientId) {
                return null;
            }
            else {
                for (let peer of this.peers) {
                    if (ids[0] === peer.remoteClient) {
                        return peer;
                    }
                }
                return null;
            }
        }

    } //masterPeer

    bindRealtime() {

        // Check realtime connection status
        let cyclesBroken = 0;
        let lastRealtimeToken = user.realtimeApiKey;
        setInterval(() => {

            if (lastRealtimeToken !== user.realtimeApiKey) {
                lastRealtimeToken = user.realtimeApiKey;
                this.realtimeBroken = false;
                cyclesBroken = 0;
            }
            else if (this.onlineEnabled && !this.realtimeConnected) {
                cyclesBroken++;

                if (cyclesBroken >= 10) this.realtimeBroken = true;
            }
            else {
                cyclesBroken = 0;
                this.realtimeBroken = false;
            }

        }, 1000);

        // Manage realtime.co connection
        //
        autorun(() => {

            if (!this.ui || this.ui.editSettings) return;

            if (realtime.apiKey !== user.realtimeApiKey) {
                if (user.realtimeApiKey && this.onlineEnabled) {
                    console.log('%cREALTIME CONNECT', 'color: #FF00FF');
                    realtime.connect(user.realtimeApiKey);
                    realtime.on('connect', () => {
                        console.log('%cREALTIME READY', 'color: #00FF00');
                        this.realtimeConnected = true;
                    });
                    realtime.on('disconnect', () => {
                        console.log('%cREALTIME DISCONNECTED', 'color: #FF0000');
                        this.realtimeConnected = false;
                    });
                    realtime.on('reconnect', () => {
                        console.log('%cREALTIME RECONNECTED', 'color: #00FF00');
                        this.realtimeConnected = true;
                    });
                }
                else {
                    console.log('%cREALTIME DISCONNECT', 'color: #FF00FF');
                    realtime.disconnect(true);
                }
            }

        });

        // Manage realtime messaging room
        //
        autorun(() => {

            if (!this.uuid) {
                // Destroy existing room, if any
                if (this.room) {
                    this.room.destroy();
                    this.room = null;
                    this.peers.splice(0, this.peers.length);
                }
            }
            else {
                // Destroy existing room, if any
                if (this.room && this.room.roomId !== this.uuid) {
                    this.room.destroy();
                    this.room = null;
                }

                if (!this.room) {
                    // Create up to date room
                    this.room = new Room(this.uuid, this.clientId);

                    // Bind events
                    //
                    this.room.on('peer-connect', (p:Peer, remoteClient:string) => {

                        console.log('%cPEER CONNECTED: ' + remoteClient, 'color: #0000FF');

                        this.bindPeer(p);

                    });
                    this.room.on('peer-close', (p:Peer, remoteClient:string) => {

                        console.log('%cPEER DISCONNECTED: ' + remoteClient, 'color: #FFBB00');

                        this.unbindPeer(p);

                    });
                }
            }

        });

        // Make project up to date in a way or another
        let sessionStatusTimeout:any = null;
        autorun(() => {

            let connected = this.realtimeConnected;

            // Connection status changed, clear previous timeout
            if (sessionStatusTimeout != null) clearTimeout(sessionStatusTimeout);

            // Start a new timeout
            sessionStatusTimeout = setTimeout(() => {

                // Now, decide whether we are master or not
                //
                if (!this.isUpToDate) {
                    // Do something to make up to date as there seem
                    // to be no remote peer responding
                }

            }, 10000);

        });

        // Automatically re-send messages for which we didn't
        // receive any confirmation receipt from remote user
        setInterval(() => {

            // No peers? Nothing to do
            if (!this.hasRemotePeers || !this.realtimeConnected) return;

            // Get current time
            let time = new Date().getTime();

            // Iterate over pending messages
            this.pendingMessagesByClientId.forEach((pendingMessages, remoteClient) => {

                // Find peer for remote client
                let p:Peer = null;
                for (let peer of this.peers) {
                    if (!peer.destroyed && peer.remoteClient === remoteClient) {
                        p = peer;
                        break;
                    }
                }

                // Then iterate over each pending message of this client
                // To check if we should still try to send messages
                let maxAttempts = 0;
                pendingMessages.forEach((pending, index) => {

                    // Increment attempts and keep max value
                    if (time - 5000 >= pending.time) {
                        maxAttempts = Math.max(pending.attempts, maxAttempts);
                        pending.attempts++;
                    }

                });
                
                // If max attempts > 12 (1 min), mark this client as expired
                if (maxAttempts > 12) {
                    this.pendingMessagesByClientId.delete(remoteClient);
                    this.expiredClientIds.set(remoteClient, true);
                }
                else {
                    // Otherwise, try to send each message again
                    pendingMessages.forEach((pending, index) => {

                        // Send message again
                        if (time - 5000 >= pending.time) {
                            p.send(JSON.stringify(pending.message));
                        }

                    });
                }

            });

        }, 2500);

    } //bindRealtime

    bindPeer(p:Peer) {

        // Keep remote client id
        let remoteClient = p.remoteClient;

        // Update peer list
        if (this.peers.indexOf(p) === -1) {
            this.peers.push(p);
        }

        // Listen to remote peer incoming messages
        this.listenToPeerMessages(p, (type:string, data?:any) => {
            
            if (type === 'sync') {
                let status:'request'|'expired'|'reply' = data.status;

                if (status === 'request') {
                    // A peer requests to sync. In that case, every client sends to each other
                    // his last modified time. If there are only 2 users, most recent changes are kept.
                    // If
                    
                }
                else if (status === 'reply') {
                    // We received a reply. Are we expecting it?
                    // If yes, keep it safe until we decide what we want to keep

                }
            }
            // Handle other kind of message only if the client is up to date
            else if (!this.expiredClientIds.has(remoteClient)) {
                
            }

        });
        
        // If we need to get updated, ask peer his last save time
        if (!this.isUpToDate) {
            this.sendPeerMessage(p, 'sync', {
                status: 'ask'
            });
        }

    } //binPeer

    unbindPeer(p:Peer) {
                        
        // Update peer list
        let peerIndex = this.peers.indexOf(p);
        if (peerIndex !== -1) {
            this.peers.splice(peerIndex, 1);
        }

    } //unbindPeer

    listenToPeerMessages(p:Peer, onMessage:(type:string, data?:any) => void) {

        let remoteClient = p.remoteClient;

        // Create required mappings if needed
        //
        if (!this.pendingMessagesByClientId.has(remoteClient)) {
            this.pendingMessagesByClientId.set(remoteClient, new Map());
        }
        if (!this.receivedMessagesByClientId.has(remoteClient)) {
            this.receivedMessagesByClientId.set(remoteClient, new Map());
        }
        if (!this.lastProcessedIndexByClientId.has(remoteClient)) {
            this.lastProcessedIndexByClientId.set(remoteClient, -1);
        }

        p.onMessage = (rawMessage:string) => {

            let parsed = JSON.parse(rawMessage);

            if (parsed.receipt) {

                // Message has been received by remote peer,
                // No need to keep it locally anymore
                let receipt:PeerMessageReceipt = parsed;
                
                // Delete confirmed message
                this.pendingMessagesByClientId.get(remoteClient).delete(parsed.number);

            }
            else {
                // Get received messsage
                let message:PeerMessage = parsed;

                // If the message is new, keep it in mapping
                let lastProcessedIndex = this.lastProcessedIndexByClientId.get(remoteClient);
                let receivedMessages = this.receivedMessagesByClientId.get(remoteClient);
                if (
                    lastProcessedIndex < message.index &&
                    !receivedMessages.has(message.index)) {
                    
                    // Add message
                    receivedMessages.set(message.index, message);
                }

                // Process new messages (if any)
                // Messages are processed in strict order depending
                // on the order they were sent by the client
                while (receivedMessages.has(lastProcessedIndex + 1)) {

                    // Get message
                    let toProcess = receivedMessages.get(lastProcessedIndex + 1);

                    try {
                        // Process message
                        onMessage(toProcess.type, toProcess.data);
                    }
                    catch (e) {
                        console.error(e);
                    }

                    // Remove processed message from mapping
                    receivedMessages.delete(lastProcessedIndex + 1);

                    // Increment processed index
                    lastProcessedIndex++;
                    this.lastProcessedIndexByClientId.set(remoteClient, lastProcessedIndex);
                }

                // Even if it's not the first time we received it,
                // Reply with a confirmation to let remote peer know about our reception.
                p.send(JSON.stringify({
                    receipt: true,
                    index: message.index
                }));
            }

        };

    } //listenToPeerMessages

    sendPeerMessage(p:Peer, type:string, data?:any) {

        let remoteClient = p.remoteClient;

        // Check that this client is not expired
        if (this.expiredClientIds.has(remoteClient) && type !== 'sync') {
            console.warn('Cannot send message to expired client: ' + remoteClient);
            return;
        }

        // Create required mappings if needed
        //
        if (!this.pendingMessagesByClientId.has(remoteClient)) {
            this.pendingMessagesByClientId.set(remoteClient, new Map());
        }
        if (!this.lastSentIndexByClientId.has(remoteClient)) {
            this.lastSentIndexByClientId.set(remoteClient, -1);
        }

        let messageIndex = this.lastSentIndexByClientId.get(remoteClient) + 1;

        let message:PeerMessage = {
            index: messageIndex,
            type: type,
            data: data
        };

        // Keep message, to re-send it if needed
        this.pendingMessagesByClientId.get(remoteClient).set(messageIndex, {
            time: new Date().getTime(),
            message: message,
            attempts: 1
        });

        // Send it
        p.send(JSON.stringify(message));

    } //sendPeerMessage

} //Project

export default Project;
