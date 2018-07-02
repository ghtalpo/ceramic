package ceramic;

import haxe.DynamicAccess;
import haxe.io.Path;

using StringTools;

#if !macro
@:build(ceramic.macros.AssetsMacro.buildLists())
#end
@:allow(ceramic.Asset)
class Assets extends Entity {

/// Events

    @event function complete(success:Bool);

    @event function update(asset:Asset);

/// Properties

    var addedAssets:Array<Asset> = [];

    var assetsByKindAndName:Map<String,Map<String,Asset>> = new Map();

    /** If set, will be provided to each added asset in this `Assets` instance. */
    public var runtimeAssets:RuntimeAssets = null;

/// Internal

    static var customAssetKinds:Map<String,CustomAssetKind> = new Map();

/// Lifecycle

    public function new() {

    } //new

    override function destroy() {

        for (asset in [].concat(addedAssets)) {
            asset.offDestroy(assetDestroyed);
            asset.destroy();
        }
        addedAssets = null;
        assetsByKindAndName = null;

    } //destroy

    /** Destroy assets that have their refCount at `0`. */
    public function flush() {

        for (asset in [].concat(addedAssets)) {
            if (asset.refCount == 0) asset.destroy();
        }

    } //flush

/// Add assets to load

    public function add(id:AssetId<Dynamic>, ?options:AssetOptions):Void {

        var value:String = Std.is(id, String) ? cast id : cast Reflect.field(id, '_id');
        var colonIndex = value.indexOf(':');

        if (colonIndex == -1) {
            throw "Assets: invalid asset id: " + id;
        }

        var kind = value.substr(0, colonIndex);
        var name = value.substr(colonIndex + 1);

        switch (kind) {
            case 'image': addImage(name, options);
            case 'text': addText(name, options);
            case 'sound': addSound(name, options);
            case 'database': addDatabase(name, options);
            case 'font': addFont(name, options);
            case 'shader': addShader(name, options);
            default:
                if (customAssetKinds.exists(kind)) {
                    customAssetKinds.get(kind).add(this, name, options);
                } else {
                    throw "Assets: invalid asset kind for id: " + id;
                }
        }

    } //add

    public function addImage(name:String, ?options:AssetOptions):Void {

        if (name.startsWith('image:')) name = name.substr(6);
        addAsset(new ImageAsset(name, options));

    } //addImage

    public function addFont(name:String, ?options:AssetOptions):Void {
        
        if (name.startsWith('font:')) name = name.substr(5);
        addAsset(new FontAsset(name, options));

    } //addFont

    public function addText(name:String, ?options:AssetOptions):Void {
        
        if (name.startsWith('text:')) name = name.substr(5);
        addAsset(new TextAsset(name, options));

    } //addText

    public function addSound(name:String, ?options:AssetOptions):Void {
        
        if (name.startsWith('sound:')) name = name.substr(6);
        addAsset(new SoundAsset(name, options));

    } //addSound

    public function addDatabase(name:String, ?options:AssetOptions):Void {
        
        if (name.startsWith('database:')) name = name.substr(9);
        addAsset(new DatabaseAsset(name, options));

    } //addDatabase

    public function addShader(name:String, ?options:AssetOptions):Void {
        
        if (name.startsWith('shader:')) name = name.substr(7);
        addAsset(new ShaderAsset(name, options));

    } //addShader

    /** Add the given asset. If a previous asset was replaced, return it. */
    public function addAsset(asset:Asset):Asset {

        if (!assetsByKindAndName.exists(asset.kind)) assetsByKindAndName.set(asset.kind, new Map());
        var byName = assetsByKindAndName.get(asset.kind);

        var previousAsset = byName.get(asset.name);
        if (previousAsset != null) {
            if (previousAsset != asset) {
                App.app.logger.log('Replace $previousAsset with $asset');
                removeAsset(previousAsset);
            } else {
                App.app.logger.warning('Cannot add asset $asset because it is already added for name: ${asset.name}.');
                return previousAsset;
            }
        }

        asset.onDestroy(this, assetDestroyed);

        byName.set(asset.name, asset);
        if (asset.owner != null && asset.owner != this) {
            asset.owner.removeAsset(asset);
        }
        addedAssets.push(asset);
        asset.owner = this;
        asset.runtimeAssets = this.runtimeAssets;

        return previousAsset;

    } //addAsset

    function assetDestroyed() {

        var toDestroy:Array<Asset> = null;
        for (asset in addedAssets) {
            if (asset.destroyed) {
                if (toDestroy == null) toDestroy = [];
                toDestroy.push(asset);
            }
        }
        if (toDestroy != null) {
            for (asset in toDestroy) {
                removeAsset(asset);
            }
        }

    } //assetDestroyed
    
    public function asset(idOrName:Either<AssetId<Dynamic>, String>, ?kind:String):Asset {

        var value:String = Std.is(idOrName, String) ? cast idOrName : cast Reflect.field(idOrName, '_id');
        var colonIndex = value.indexOf(':');

        var name:String = value;

        if (colonIndex != -1) {
            name = value.substring(colonIndex + 1);
            kind = value.substring(0, colonIndex);
        }

        if (kind == null) return null;
        var byName = assetsByKindAndName.get(kind);
        if (byName == null) return null;
        return byName.get(name);

    } //asset

    public function removeAsset(asset:Asset):Void {

        asset.offDestroy(assetDestroyed);

        var byName = assetsByKindAndName.get(asset.kind);
        var toRemove = byName.get(asset.name);

        if (asset != toRemove) {
            throw 'Cannot remove asset $asset if it was not added at the first place.';
        }

        addedAssets.remove(asset);
        byName.remove(asset.name);
        asset.owner = null;

    } //removeAsset

/// Load

    public function load():Void {

        var pending = 0;
        var allSuccess = true;

        // Prepare loading
        for (asset in addedAssets) {

            if (asset.status == NONE) {

                asset.onceComplete(this, function(success) {

                    if (!success) {
                        allSuccess = false;
                        App.app.logger.error('Failed to load asset ${asset.name} ($asset)');
                    }

                    pending--;
                    if (pending == 0) {
                        emitComplete(allSuccess);
                    }

                });
                pending++;

            }

        }

        // Load
        if (pending > 0) {

            for (asset in addedAssets) {

                if (asset.status == NONE) {
                    asset.load();
                }

            }

        } else {

            App.app.logger.warning('There was no asset to load.');
            emitComplete(true);

        }

    } //load

/// Ensure

    /** Ensures and asset is loaded and return it on the callback.
        This will check if the requested asset is currently being loaded,
        already loaded or should be added and loaded. In all cases, it will try
        its best to deliver the requested asset or `null` if something went wrong. */
    public function ensure(id:AssetId<Dynamic>, ?options:AssetOptions, done:Asset->Void):Void {

        // Asset already added?
        var existing = this.asset(id);
        var asset:Asset = null;

        if (existing == null) {
            // No? Add it and get it back
            add(id, options);
            asset = this.asset(id);
        } else {
            // Yes, use it
            asset = existing;
        }

        if (asset == null) {
            // Asset is null? It seems invalid then
            done(null);
            return;
        }

        // Depending on asset status, do the right thing
        if (asset.status == READY) {
            // Already available
            done(asset);
        }
        else if (asset.status == LOADING || asset.status == NONE) {
            // Wait until asset is loaded
            asset.onceComplete(function(success) {
                if (success) {
                    done(asset);
                }
                else {
                    done(null);
                }
            });

            if (asset.status == NONE) {
                // Start loading
                this.load();
            }
        }
        else {
            // Broken?
            done(null);
        }

    } //ensure

    public function ensureImage(name:Either<String,AssetId<String>>, ?options:AssetOptions, done:ImageAsset->Void):Void {

        if (!name.startsWith('image:')) name = 'image:' + name;
        ensure(cast name, options, function(asset) {
            done(Std.is(asset, ImageAsset) ? cast asset : null);
        });

    } //ensureImage

    public function ensureFont(name:Either<String,AssetId<String>>, ?options:AssetOptions, done:FontAsset->Void):Void {

        if (!name.startsWith('font:')) name = 'font:' + name;
        ensure(cast name, options, function(asset) {
            done(Std.is(asset, FontAsset) ? cast asset : null);
        });

    } //ensureFont

    public function ensureText(name:Either<String,AssetId<String>>, ?options:AssetOptions, done:TextAsset->Void):Void {

        if (!name.startsWith('text:')) name = 'text:' + name;
        ensure(cast name, options, function(asset) {
            done(Std.is(asset, TextAsset) ? cast asset : null);
        });

    } //ensureText

    public function ensureSound(name:Either<String,AssetId<String>>, ?options:AssetOptions, done:SoundAsset->Void):Void {

        if (!name.startsWith('sound:')) name = 'sound:' + name;
        ensure(cast name, options, function(asset) {
            done(Std.is(asset, SoundAsset) ? cast asset : null);
        });

    } //ensureSound

    public function ensureDatabase(name:Either<String,AssetId<String>>, ?options:AssetOptions, done:DatabaseAsset->Void):Void {

        if (!name.startsWith('database:')) name = 'database:' + name;
        ensure(cast name, options, function(asset) {
            done(Std.is(asset, DatabaseAsset) ? cast asset : null);
        });

    } //ensureDatabase

    public function ensureShader(name:Either<String,AssetId<String>>, ?options:AssetOptions, done:ShaderAsset->Void):Void {

        if (!name.startsWith('shader:')) name = 'shader:' + name;
        ensure(cast name, options, function(asset) {
            done(Std.is(asset, ShaderAsset) ? cast asset : null);
        });

    } //ensureShader

/// Get

    public function texture(name:Either<String,AssetId<String>>):Texture {

        var realName:String = cast name;
        if (realName.startsWith('image:')) realName = realName.substr(6);

        if (!assetsByKindAndName.exists('image')) return null;
        var asset:ImageAsset = cast assetsByKindAndName.get('image').get(realName);
        if (asset == null) return null;

        return asset.texture;

    } //texture

    public function font(name:Either<String,AssetId<String>>):BitmapFont {

        var realName:String = cast name;
        if (realName.startsWith('font:')) realName = realName.substr(5);
        
        if (!assetsByKindAndName.exists('font')) return null;
        var asset:FontAsset = cast assetsByKindAndName.get('font').get(realName);
        if (asset == null) return null;

        return asset.font;

    } //font

    public function sound(name:Either<String,AssetId<String>>):Sound {

        var realName:String = cast name;
        if (realName.startsWith('sound:')) realName = realName.substr(6);
        
        if (!assetsByKindAndName.exists('sound')) return null;
        var asset:SoundAsset = cast assetsByKindAndName.get('sound').get(realName);
        if (asset == null) return null;

        return asset.sound;

    } //sound

    public function text(name:Either<String,AssetId<String>>):String {

        var realName:String = cast name;
        if (realName.startsWith('text:')) realName = realName.substr(5);
        
        if (!assetsByKindAndName.exists('text')) return null;
        var asset:TextAsset = cast assetsByKindAndName.get('text').get(realName);
        if (asset == null) return null;

        return asset.text;

    } //text

    public function shader(name:Either<String,AssetId<String>>):Shader {

        var realName:String = cast name;
        if (realName.startsWith('shader:')) realName = realName.substr(7);
        
        if (!assetsByKindAndName.exists('shader')) return null;
        var asset:ShaderAsset = cast assetsByKindAndName.get('shader').get(realName);
        if (asset == null) return null;

        return asset.shader;

    } //shader

    public function database(name:Either<String,AssetId<String>>):Array<DynamicAccess<String>> {

        var realName:String = cast name;
        if (realName.startsWith('database:')) realName = realName.substr(9);
        
        if (!assetsByKindAndName.exists('database')) return null;
        var asset:DatabaseAsset = cast assetsByKindAndName.get('database').get(realName);
        if (asset == null) return null;

        return asset.database;

    } //database

/// Iterator

    public function iterator():Iterator<Asset> {

        var list:Array<Asset> = [];

        for (byName in assetsByKindAndName) {
            for (asset in byName) {
                list.push(asset);
            }
        }

        return list.iterator();

    } //iterator

/// Static helpers

    public static function decodePath(path:String):AssetPathInfo {

        return new AssetPathInfo(path);

    } //decodePath

    public static function addAssetKind(kind:String, add:Assets->String->?AssetOptions->Void, extensions:Array<String>, dir:Bool, types:Array<String>):Void {

        customAssetKinds.set(kind, {
            kind: kind,
            add: add,
            extensions: extensions,
            dir: dir,
            types: types
        });

    } //addAssetKind

} //Assets
