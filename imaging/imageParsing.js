/** @module imaging/imageParsing
 *  @desc  This file provides functionalities for parsing DICOM image files
 */

// external libraries
import { parseDicom } from "dicom-parser";
import { forEach, each, has, pick } from "lodash";
import { v4 as uuidv4 } from "uuid";

// internal libraries
import { getPixelRepresentation, randomId, parseTag } from "./imageUtils.js";
import { updateLoadedStack } from "./imageLoading.js";
import { checkMemoryAllocation } from "./monitors/memory.js";

// global module variables
var t0 = null; // t0 variable for timing debugging purpose

/*
 * This module provides the following functions to be exported:
 * readFiles(fileList)
 * readFile(file)
 * parseDataSet(dataSet, metadata, customFilter)
 * clearImageParsing(seriesStack)
 */

/**
 * Reset series stack object and its internal data
 * @instance
 * @function clearImageParsing
 * @param {Object} seriesStack - Parsed series stack object
 */
export const clearImageParsing = function (seriesStack) {
  each(seriesStack, function (stack) {
    each(stack.instances, function (instance) {
      if (instance.dataSet) {
        instance.dataSet.byteArray = null;
      }
      instance.dataSet = null;
      instance.file = null;
      instance.metadata = null;
    });
  });
  seriesStack = null;
};

/**
 * Read dicom files and return allSeriesStack object
 * @instance
 * @function readFiles
 * @param {Array} entries - List of file objects
 * @returns {Promise} - Return a promise which will resolve to a image object list or fail if an error occurs
 */
export const readFiles = function (entries) {
  let promise = new Promise((resolve, reject) => {
    parseFiles(entries).then(resolve).catch(reject);
  });
  return promise;
};

/**
 * Read a single dicom file and return parsed object
 * @instance
 * @function readFile
 * @param {File} entry - File object
 * @returns {Promise} - Return a promise which will resolve to a image object or fail if an error occurs
 */
export const readFile = function (entry) {
  let promise = new Promise((resolve, reject) => {
    parseFile(entry).then(resolve).catch(reject);
  });
  return promise;
};

/* Internal module functions */

/**
 * Parse metadata from dicom parser dataSet object
 * @instance
 * @function parseDataSet
 * @param {Object} dataSet - dicom parser dataSet object
 * @param {Array} metadata - Initialized metadata object
 * @param {Array} customFilter - Optional filter: {tags:[], frameId: 0}
 */
// This function iterates through dataSet recursively and adds new HTML strings
// to the output array passed into it
export const parseDataSet = function (dataSet, metadata, customFilter) {
  // customFilter= {tags:[], frameId:xxx}
  // the dataSet.elements object contains properties for each element parsed.  The name of the property
  // is based on the elements tag and looks like 'xGGGGEEEE' where GGGG is the group number and EEEE is the
  // element number both with lowercase hexadecimal letters.  For example, the Series Description DICOM element 0008,103E would
  // be named 'x0008103e'.  Here we iterate over each property (element) so we can build a string describing its
  // contents to add to the output array
  try {
    let elements =
      customFilter && has(customFilter, "tags")
        ? pick(dataSet.elements, customFilter.tags)
        : dataSet.elements;
    for (let propertyName in elements) {
      let element = elements[propertyName];
      // Here we check for Sequence items and iterate over them if present.  items will not be set in the
      // element object for elements that don't have SQ VR type.  Note that implicit little endian
      // sequences will are currently not parsed.
      if (element.items) {
        // each item contains its own data set so we iterate over the items
        // and recursively call this function
        if (customFilter && has(customFilter, "frameId")) {
          let item = element.items[customFilter.frameId];
          parseDataSet(item.dataSet, metadata);
        } else {
          element.items.forEach(function (item) {
            parseDataSet(item.dataSet, metadata);
          });
        }
      } else {
        let tagValue = parseTag(dataSet, propertyName, element);
        metadata[propertyName] = tagValue;
      }
    }
  } catch (err) {
    console.log(err);
  }
};

/**
 * Manage the parsing process waiting for the parsed object before proceeding with the next parse request
 * @inner
 * @function parseNextFile
 * @param {Array} parsingQueue - Array of queued files to be parsed
 * @param {Object} allSeriesStack - Series stack object to be populated
 * @param {string} uuid - Series uuid to be used if series instance uuid is missing
 * @param {Function} resolve - Promise resolve function
 * @param {Function} reject - Promise reject function
 */
let parseNextFile = function (
  parsingQueue,
  allSeriesStack,
  uuid,
  resolve,
  reject
) {
  // initialize t0 on first file of the queue
  if (
    Object.keys(allSeriesStack).length === 0 &&
    allSeriesStack.constructor === Object
  ) {
    t0 = performance.now();
  }

  if (parsingQueue.length === 0) {
    let t1 = performance.now();
    console.log(`Call to readFiles took ${t1 - t0} milliseconds.`);
    resolve(allSeriesStack);
    return;
  }

  // remove and return first item from queue
  let file = parsingQueue.shift();

  // Check if there is enough memory to parse the file
  if (checkMemoryAllocation(file.size) === false) {
    // do not parse the file and stop parsing
    clearImageParsing(allSeriesStack);
    let t1 = performance.now();
    console.log(`Call to readFiles took ${t1 - t0} milliseconds.`);
    file = null;
    reject("Available memory is not enough");
    return;
  } else {
    // parse the file and wait for results
    parseFile(file)
      .then(seriesData => {
        // use generated series uid if not found in dicom file
        seriesData.metadata.seriesUID = seriesData.metadata.seriesUID || uuid;
        // add file to cornerstoneWADOImageLoader file manager
        updateLoadedStack(seriesData, allSeriesStack);
        // proceed with the next file to parse
        parseNextFile(parsingQueue, allSeriesStack, uuid, resolve, reject);
        seriesData = null;
        file = null;
      })
      .catch(err => {
        console.warn(err);
        parseNextFile(parsingQueue, allSeriesStack, uuid, resolve, reject);
        file = null;
      });
  }
};

/**
 * Push files in queue and start parsing next file
 * @inner
 * @function parseFiles
 * @param {Array} fileList - Array of file objects
 * @returns {Promise} - Return a promise which will resolve to a image object list or fail if an error occurs
 */
let parseFiles = function (fileList) {
  let allSeriesStack = {};
  let parsingQueue = [];

  forEach(fileList, function (file) {
    if (!file.name.startsWith(".") && !file.name.startsWith("DICOMDIR")) {
      parsingQueue.push(file);
    }
  });
  return new Promise((resolve, reject) => {
    const uuid = uuidv4();
    parseNextFile(parsingQueue, allSeriesStack, uuid, resolve, reject);
  });
};

/**
 * Parse a single DICOM File (metaData and pixelData)
 * @inner
 * @function parseFile
 * @param {File} file - File object to be parsed
 * @returns {Promise} - Return a promise which will resolve to a image object or fail if an error occurs
 */
let parseFile = function (file) {
  let parsePromise = new Promise((resolve, reject) => {
    let reader = new FileReader();
    reader.onload = function () {
      let arrayBuffer = reader.result;
      // Here we have the file data as an ArrayBuffer.
      // dicomParser requires as input a Uint8Array so we create that here.
      let byteArray = new Uint8Array(arrayBuffer);
      let dataSet;

      try {
        dataSet = parseDicom(byteArray);
        byteArray = null;
        let metadata = {};
        parseDataSet(dataSet, metadata);

        let temporalPositionIdentifier = metadata["x00200100"]; // Temporal order of a dynamic or functional set of Images.
        let numberOfTemporalPositions = metadata["x00200105"]; // Total number of temporal positions prescribed.
        const is4D =
          (temporalPositionIdentifier !== undefined) &
          (numberOfTemporalPositions > 1)
            ? true
            : false;

        let numberOfFrames = metadata["x00280008"];
        let isMultiframe = numberOfFrames > 1 ? true : false;
        // Overwrite SOPInstanceUID to manage multiframes.
        // Usually different SeriesInstanceUID means different series and that value
        // is used into the application to group different instances into the same series,
        // but if a DICOM file contains a multiframe series, then the SeriesInstanceUID
        // can be shared by other files of the same study.
        // In multiframe cases, the SOPInstanceUID (unique) is used as SeriesInstanceUID.
        let seriesInstanceUID = isMultiframe
          ? metadata["x00080018"]
          : metadata["x0020000e"];
        let pixelSpacing = metadata["x00280030"];
        let imageOrientation = metadata["x00200037"];
        let imagePosition = metadata["x00200032"];
        let sliceThickness = metadata["x00180050"];

        if (dataSet.warnings.length > 0) {
          // warnings
          reject(dataSet.warnings);
        } else {
          let pixelDataElement = dataSet.elements.x7fe00010;

          if (pixelDataElement) {
            // done, pixelDataElement found
            let instanceUID = metadata["x00080018"] || randomId();
            let imageObject = {
              // data needed for rendering
              file: file,
              dataSet: dataSet
            };
            imageObject.metadata = metadata;
            imageObject.metadata.seriesUID = seriesInstanceUID;
            imageObject.metadata.instanceUID = instanceUID;
            imageObject.metadata.studyUID = metadata["x0020000d"];
            imageObject.metadata.accessionNumber = metadata["x00080050"];
            imageObject.metadata.studyDescription = metadata["x00081030"];
            imageObject.metadata.patientName = metadata["x00100010"];
            imageObject.metadata.patientBirthdate = metadata["x00100030"];
            imageObject.metadata.seriesDescription = metadata["x0008103e"];
            imageObject.metadata.seriesDate = metadata["x00080021"];
            imageObject.metadata.seriesModality =
              metadata["x00080060"].toLowerCase();
            imageObject.metadata.intercept = metadata["x00281052"];
            imageObject.metadata.slope = metadata["x00281053"];
            imageObject.metadata.pixelSpacing = pixelSpacing;
            imageObject.metadata.sliceThickness = sliceThickness;
            imageObject.metadata.imageOrientation = imageOrientation;
            imageObject.metadata.imagePosition = imagePosition;
            imageObject.metadata.rows = metadata["x00280010"];
            imageObject.metadata.cols = metadata["x00280011"];
            imageObject.metadata.numberOfSlices = metadata["x00540081"]
              ? metadata["x00540081"] // number of slices
              : metadata["x00201002"]; // number of instances
            imageObject.metadata.numberOfFrames = numberOfFrames;
            if (isMultiframe) {
              imageObject.metadata.frameTime = metadata["x00181063"];
              imageObject.metadata.frameDelay = metadata["x00181066"];
            }
            imageObject.metadata.isMultiframe = isMultiframe;
            if (is4D) {
              imageObject.metadata.temporalPositionIdentifier =
                metadata["x00200100"];
              imageObject.metadata.numberOfTemporalPositions =
                metadata["x00200105"];
              imageObject.metadata.contentTime = metadata["x00080033"];
            }
            imageObject.metadata.is4D = is4D;
            imageObject.metadata.windowCenter = metadata["x00281050"];
            imageObject.metadata.windowWidth = metadata["x00281051"];
            imageObject.metadata.minPixelValue = metadata["x00280106"];
            imageObject.metadata.maxPixelValue = metadata["x00280107"];
            imageObject.metadata.length = pixelDataElement.length;
            imageObject.metadata.repr = getPixelRepresentation(dataSet);
            resolve(imageObject);
          } else {
            // done, no pixelData
            reject("no pixelData");
          }
        }
      } catch (err) {
        console.warn(err);
        reject("can not read this file");
      }
    };
    reader.readAsArrayBuffer(file);
  });
  return parsePromise;
};
