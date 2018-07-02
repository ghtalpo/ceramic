package ceramic;

import ceramic.Shortcuts.*;

class SoundAsset extends Asset {

    public var stream:Bool = false;

    public var sound:Sound = null;

    override public function new(name:String, ?options:AssetOptions) {

        super('sound', name, options);

    } //name

    override public function load() {

        status = LOADING;

        if (path == null) {
            warning('Cannot load sound asset if path is undefined.');
            status = BROKEN;
            emitComplete(false);
            return;
        }

        log('Load sound $path');
        app.backend.audio.load(path, { stream: options.stream }, function(audio) {

            if (audio != null) {
                this.sound = new Sound(audio);
                this.sound.asset = this;
                status = READY;
                emitComplete(true);
            }
            else {
                status = BROKEN;
                error('Failed to load audio at path: $path');
                emitComplete(false);
            }

        });

    } //load

    override function destroy():Void {

        if (sound != null) {
            sound.destroy();
            sound = null;
        }

    } //destroy

} //SoundAsset
