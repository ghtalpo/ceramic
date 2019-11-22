package tools.tasks.spine;

import tools.Helpers.*;
import tools.Project;
import haxe.io.Path;
import haxe.Json;
import haxe.crypto.Md5;
import sys.FileSystem;
import sys.io.File;

using StringTools;

class ExportSpine extends tools.Task {

    override public function info(cwd:String):String {

        return "Export spine animations from a Spine project to usable assets.";

    } //info

    override function run(cwd:String, args:Array<String>):Void {

        ensureCeramicProject(cwd, args, App);

        // Get project info
        var projectPath = Path.join([cwd, 'ceramic.yml']);
        var assetsPath = Path.join([cwd, 'assets']);
        var projectCachePath = Path.join([cwd, '.cache']);
        var tmpPath = Path.join([cwd, '.tmp']);
        var spineDefaultConfigPath = Path.join([cwd, 'resources/spine-config.json']);
        var project = new tools.Project();
        var force = extractArgFlag(args, 'force');
        var stripAnimFolders = extractArgFlag(args, 'strip-animation-folders');
        var stripSkinFolders = extractArgFlag(args, 'strip-skin-folders');
        project.loadAppFile(projectPath);

        if (project.app.spine == null || !Std.is(project.app.spine.export, Array)) {
            fail('Missing spine export option in ceramic.yml file like:

    spine:
        export:
            - path/to/Project.spine

');
        }

        if (!FileSystem.exists(tmpPath)) {
            FileSystem.createDirectory(tmpPath);
        }

        var spineAppPath:String = null;
        if (Sys.systemName() == 'Mac') {
            spineAppPath = '/Applications/Spine/Spine.app/Contents/MacOS/Spine';
        } else if (Sys.systemName() == 'Windows') {
            spineAppPath = 'C:\\Program Files (x86)\\Spine\\Spine.com';
        } else {
            fail('Spine export is not yet supported on ' + Sys.systemName() + ' system.');
        }

        var exportList:Array<Dynamic> = project.app.spine.export;
        for (rawItem in exportList) {

            var spineConfigPath:String = null;

            var path:String = null;
            if (Std.is(rawItem, String)) {
                path = rawItem;
            } else {
                path = rawItem.path;
                if (rawItem.config != null) {
                    print('Use custom config: ' + rawItem.config);
                    spineConfigPath = Path.join([cwd, 'resources/' + rawItem.config]);
                }
            }

            if (path == null) {
                fail('Missing spine project path');
            }

            if (spineConfigPath == null) {
                if (!FileSystem.exists(spineDefaultConfigPath)) {
                    fail('Missing Spine export config file at resources/spine-config.json');
                }
                spineConfigPath = spineDefaultConfigPath;
            }
            else {
                if (!FileSystem.exists(spineConfigPath)) {
                    fail('Missing Spine export config file at ' + rawItem.config);
                }
            }

            var spineConfig:Dynamic = null;
            try {
                spineConfig = Json.parse(File.getContent(spineConfigPath));
            }
            catch (e:Dynamic) {
                fail('Failed to parse spine export config file: ' + e);
            }

            if (!Path.isAbsolute(path)) path = Path.join([cwd, path]);

            // Create export config
            var exportPath = Path.join([tmpPath, 'spine']);
            spineConfig.project = path;
            spineConfig.output = exportPath;

            // Compute absolute spine project path
            var spineProjectPath = path;
            if (!Path.isAbsolute(spineProjectPath)) {
                spineProjectPath = Path.join([context.cwd, spineProjectPath]);
            }

            var projectKey = Md5.encode('spine:'+path);
            var projectKeyPath = Path.join([projectCachePath, projectKey]);
            if (!force) {
                // Check last modified date to see if this entry needs to be converted again or not
                if (FileSystem.exists(projectKeyPath)) {
                    if (Files.haveSameLastModified(spineProjectPath, projectKeyPath)) {
                        print('Skip ' + path);
                        continue;
                    }
                }
            }

            // Save export config for use right after
            var tmpConfigPath = Path.join([tmpPath, 'spine-config.json']);
            File.saveContent(tmpConfigPath, Json.stringify(spineConfig, null, '  '));

            // Remove any previously exported files
            if (FileSystem.exists(exportPath)) {
                Files.deleteRecursive(exportPath);
            }

            FileSystem.createDirectory(exportPath);

            // Export
            command(spineAppPath, ['--export', tmpConfigPath]);

            // Move files to assets directory
            //
            var skeletons:Map<String,Array<String>> = new Map();

            for (item in Files.getFlatDirectory(exportPath)) {
                var name = Path.withoutDirectory(Path.withoutExtension(item));
                if (name.indexOf('@') != -1) name = name.substring(0, name.indexOf('@'));
                
                var entries = skeletons.get(name);
                if (entries == null) {
                    entries = [];
                    skeletons.set(name, entries);
                }
                entries.push(item);
            }

            // Gather atlas info
            //
            var skeletonAtlases = new Map<String,Array<String>>();

            for (groupName in skeletons.keys()) {
                var groupDirRelative = groupName + '.spine';

                for (name in skeletons.get(groupName)) {
                    var outName = convertName(name);
                    var ext = Path.extension(outName);
                    
                    if (ext == 'atlas') {
                        var atlases = skeletonAtlases.get(groupName);
                        if (atlases == null) {
                            atlases = [];
                            skeletonAtlases.set(groupName, atlases);
                        }
                        atlases.push(Path.join([groupDirRelative, outName]));
                    }
                }

            }

            // Do the actual moving
            //
            for (groupName in skeletons.keys()) {
                print('Add assets/' + groupName + '.spine');

                var groupDir = Path.join([assetsPath, groupName + '.spine']);

                if (FileSystem.exists(groupDir)) {
                    Files.deleteRecursive(groupDir);
                }
                FileSystem.createDirectory(groupDir);

                // Ensure suffixes generated by spine will
                // match ceramic's asset naming system
                for (name in skeletons.get(groupName)) {
                    var outName = convertName(name);
                    var ext = Path.extension(outName);

                    if (ext == 'atlas') {
                        // Convert atlas
                        var atlasContent = File.getContent(Path.join([tmpPath, 'spine', name]));

                        atlasContent = convertAtlas(atlasContent);
                        File.saveContent(Path.join([groupDir, outName]), atlasContent);

                    }
                    else if (ext == 'json') {
                        // Patch json if needed
                        var jsonContent = File.getContent(Path.join([tmpPath, 'spine', name]));
                        var parsed = Json.parse(jsonContent);

                        // Strip skin folders in names?
                        if (stripSkinFolders) {
                            if (parsed.skins != null) {
                                var usedSkinNames = new Map<String,Bool>();
                                var skins:Array<{name:String}> = parsed.skins;
                                for (skin in skins) {
                                    var lastSlashIndex = skin.name.lastIndexOf('/');
                                    if (lastSlashIndex != -1) {
                                        skin.name = skin.name.substring(lastSlashIndex + 1);
                                    }
                                    if (usedSkinNames.exists(skin.name)) {
                                        fail('Duplicate skin name: ${skin.name} (skeleton: $name)');
                                    }
                                    usedSkinNames.set(skin.name, true);
                                }
                            }
                        }

                        // Strip anim folders in names?
                        if (stripAnimFolders) {
                            if (parsed.animations != null) {
                                for (key in Reflect.fields(parsed.animations)) {
                                    var newKey = key;
                                    var lastSlashIndex = key.lastIndexOf('/');
                                    if (lastSlashIndex != -1) {
                                        newKey = key.substring(lastSlashIndex + 1);
                                    }
                                    if (newKey != key) {
                                        if (Reflect.field(parsed.animations, newKey) != null) {
                                            fail('Duplicate animation name: $newKey (skeleton: $name)');
                                        }
                                        Reflect.setField(parsed.animations, newKey, Reflect.field(parsed.animations, key));
                                        Reflect.deleteField(parsed.animations, key);
                                    }
                                }
                            }
                        }

                        // Save content
                        File.saveContent(Path.join([groupDir, outName]), Json.stringify(parsed, null, '    '));
                    }
                    else {
                        // Just copy
                        File.copy(
                            Path.join([tmpPath, 'spine', name]),
                            Path.join([groupDir, outName])
                        );
                    }
                }

                // Link to another atlas if needed
                if (!skeletonAtlases.exists(groupName)) {
                    for (atlasKey in skeletonAtlases.keys()) {
                        var atlases = skeletonAtlases.get(atlasKey);
                        for (atlas in atlases) {
                            var name = Path.withoutDirectory(atlas);
                            var suffix = name.substring(atlasKey.length);
                            File.saveContent(Path.join([groupDir, groupName + suffix]), 'alias:' + atlas);
                        }
                        // No need to iterate more
                        break;
                    }
                }
            }

            // Keep a local cache file to track which asset will need to be updated next time
            if (!FileSystem.exists(projectCachePath)) {
                FileSystem.createDirectory(projectCachePath);
            }
            File.saveContent(projectKeyPath, path);
            Files.setToSameLastModified(spineProjectPath, projectKeyPath);

        }

        // Cleanup
        Files.deleteRecursive(tmpPath);

    } //run

    function convertName(inName:String) {

        var withoutExt = Path.withoutExtension(inName);
        var ext = Path.extension(inName);
        if (RE_AT_NX.match(withoutExt)) {
            withoutExt = withoutExt.substring(0, withoutExt.length - RE_AT_NX.matched(0).length);
            if (RE_AT_NX.matched(2) != null) {
                withoutExt += RE_AT_NX.matched(2);
            }
            withoutExt += '@' + RE_AT_NX.matched(1);
            return withoutExt + 'x.' + ext;
        }
        else {
            return inName;
        }

    } //convertName

    function convertAtlas(inAtlas:String) {

        var lines = inAtlas.replace("\r",'').split("\n");
        var newLines = [];
        for (line in lines) {
            if (RE_PNG.match(line)) {
                line = convertName(line);
            }
            newLines.push(line);
        }

        return newLines.join("\n");

    } //convertAtlas

    static var RE_AT_NX = ~/@([0-9]+(?:\.[0-9]+)?)x([0-9]+)?$/;
    static var RE_PNG = ~/\.(png|PNG)$/;

} //ExportSpine
