require('./text-polyfill');

const { MUSE_SERVICE, MuseClient, zipSamples, channelNames } = require('muse-js');
const noble = require('noble');
const bleat = require('bleat').webbluetooth;
const lsl = require('node-lsl');
const { Observable } = require('rxjs');
const gpio = require('rpi-gpio')
const gpiop = gpio.promise;
const asciichart = require('asciichart');
const Fili = require('fili');
const iirCalculator = new Fili.CalcCascades();
const firCalculator = new Fili.FirCoeffs();

gpio.setMode(gpio.MODE_BCM);
gpiop.setup(17, gpio.DIR_OUT)
    .then(() => {
        return gpiop.write(17, true);
    })
    .catch((err) => {
        console.log('Error: ', err.toString());
    });

async function connect() {
    let device = await bleat.requestDevice({
        filters: [{ services: [MUSE_SERVICE] }]
    });
    const gatt = await device.gatt.connect();
    console.log('Device name:', gatt.device.name);

    const client = new MuseClient();
    await client.connect(gatt);
    client.controlResponses.subscribe(x => console.log('Response:', x));
    await client.start();
    console.log('Connected!');
    return client;
}

function streamLsl(client) {
    console.log('LSL: Creating Stream...');

    // These packets keep the connection alive
    const keepaliveTimer = setInterval(() => client.sendCommand(''), 3000);

    /*
    const info = lsl.create_streaminfo("Muse", "EEG", 5, 256, lsl.channel_format_t.cft_float32, client.deviceName);
    const desc = lsl.get_desc(info);
    lsl.append_child_value(desc, "manufacturer", "Interaxon");
    const channels = lsl.append_child(desc, "channels");
    for (let i = 0; i < 5; i++) {
        const channel = lsl.append_child(channels, "channel");
        lsl.append_child_value(channel, "label", channelNames[i]);
        lsl.append_child_value(channel, "unit", "microvolts");
        lsl.append_child_value(channel, "type", "EEG");
    }

    const outlet = lsl.create_outlet(info, 0, 360);
    */

    let sampleCounter = 0;
    
    const leftEyeChannel = channelNames.indexOf('AF7');
    const leftBackChannel = channelNames.indexOf('TP9');

    state = true;
    client.eegReadings
        .filter(r => r.electrode === leftEyeChannel)
        .map(r => Math.max(...r.samples.map(n => Math.abs(n))))
        .filter(max => max > 50)
	.debounceTime(150)
        .subscribe(v => {
            // gpiop.write(17, !!(sampleCounter % 2))
	    // console.log(v)
	    state = !state;
            gpiop.write(17, state)
                .catch((err) => {
                    console.log('Error: ', err.toString());
                });
        });
    
    Math.sum = (...a) => Array.prototype.reduce.call(a,(a,b) => a+b)
    Math.avg = (...a) => Math.sum(...a)/a.length;
    const resize_array_right = (array, length, fill_with) => array.concat((new Array(length)).fill(fill_with)).slice(0, length);
    const resize_array_left = (array, length, fill_with) => (new Array(length)).fill(fill_with).concat(array).slice(-length);

    const iirFilterCoeffsL = firCalculator.lowpass({
         order: 100, // cascade 3 biquad filters (max: 12)
         characteristic: 'butterworth',
         // BW: 1, // bandwidth only for bandstop and bandpass filters - optional
         Fs: 256, // sampling frequency
         Fc: 12, // cutoff frequency / center frequency for bandpass, bandstop, peak
    });
    const iirFilterL = new Fili.FirFilter(iirFilterCoeffsL);
    const iirFilterCoeffsH = firCalculator.highpass({
         order: 100, // cascade 3 biquad filters (max: 12)
         characteristic: 'butterworth',
         // BW: 1, // bandwidth only for bandstop and bandpass filters - optional
         Fs: 256, // sampling frequency
         Fc: 8, // cutoff frequency / center frequency for bandpass, bandstop, peak
    });
    const iirFilterH = new Fili.FirFilter(iirFilterCoeffsH);
    
    // Observable.from(zipSamples(client.eegReadings))
    //     .subscribe(d => {
    //         console.log(d)
    //     });
    var windowSize = process.stdout.columns-20; // let a bit of space for labels & grid lines
    const maxSlidingWindowSize = 115;
    var slidingWindowSize = Math.min(windowSize, maxSlidingWindowSize);
    var height = process.stdout.rows-4 && 10;
    process.stdout.on('resize', () => {
        windowSize = process.stdout.columns - 20;
        height = process.stdout.rows - 4 && 20;
	slidingWindowSize = Math.min(windowSize, maxSlidingWindowSize);
        // Override sliding window to map filter sampling rate 
        // !!!
        slidingWindowSize = 256;
    });
    let onStdoutEvent = Observable.bindNodeCallback(process.stdout.on.bind(process.stdout));
    let terminalHasResizedStream = onStdoutEvent('resize')
	    .map(d => ({ terminalHasResized: true }));

    // Override sliding window to map filter sampling rate 
    // !!!
    slidingWindowSize = 256;

    let stream = Observable.from(zipSamples(client.eegReadings))
	// .skip(256*10)
        .map(d => d.data)
	// average electrodes & filter out empty last value
	.map(d => d.map(n => typeof n !== 'number' || Number.isNaN(n) ? -200 : n))
	// .map(d => d.slice(0, 4))
	//.map(d => Math.avg(...d))
	.map(d => d[leftBackChannel])
	// average at ~15ms (1/256 * 4)
        .bufferCount(12)
	.map(d => Math.avg(...d))
	
    // draw last 200 values (sliding window)
    stream
	.merge(terminalHasResizedStream)
	.scan((acc, curr) => {
		// reset data if terminal window has resized (as sliding window size depends on this)
		if (typeof curr === 'object' && curr.terminalHasResized) {
			return [];
		}
		// rotate buffer
		if (acc.length >= slidingWindowSize) {
			acc.shift();
		}
		// add new item
		acc.push(curr);
		// return value
		return acc;
	}, [])
        .subscribe(d => {
	    d = d.slice(0);
	    
            process.stdout.write('\x1B[?25l'); // hide cursor
            // process.stdout.clearLine();
	    // process.stdout.moveCursor(0, -height-2);
	    process.stdout.cursorTo(0, 0);
            
	    if (d.length < slidingWindowSize) {
		d = resize_array_left(d, slidingWindowSize, 0);
	    }
	    // d = iirFilterL.multiStep(d);
	    // d = iirFilterH.multiStep(d);

 	    // d[0] = -30;
	    // d[slidingWindowSize-1] = 30;
 	    d[0] = -200;
	    d[slidingWindowSize-1] = 200;

	    process.stdout.write(asciichart.plot(d, {
		height: height,
	    }));
	    process.stdout.write('\x1B[?25h');
        });
    
    Observable.from(zipSamples(client.eegReadings))
        .finally(() => {
              // lsl.lsl_destroy_outlet(outlet);
              clearInterval(keepaliveTimer);
        })    
        .subscribe(sample => {
            // const sampleData = new lsl.FloatArray(sample.data);
            // lsl.push_sample_ft(outlet, sampleData, lsl.local_clock());
            // sampleCounter++;

            // process.stdout.clearLine();
            // process.stdout.cursorTo(0);
            // process.stdout.write(`LSL: Sent ${sampleCounter} samples`);
        });
}

noble.on('stateChange', (state) => {
    if (state === 'poweredOn') {
        connect().then(streamLsl);
    }
});
