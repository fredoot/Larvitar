/** @module imaging/imageReslice
 *  @desc  This file provides functionalities for
 *         image reslice in orthogonal directions
 */

// external libraries
import { v4 as uuidv4 } from "uuid";
import { each } from "lodash";

// internal libraries
import { getReslicedMetadata, getReslicedPixeldata } from "./imageUtils";
import {
  getLarvitarImageTracker,
  getLarvitarManager
} from "./loaders/commonLoader";
import { larvitar_store } from "./imageStore";

/*
 * This module provides the following functions to be exported:
 * resliceSeries(seriesId, seriesData, orientation)
 */

/**
 * Reslice a serie from native orientation to coronal or sagittal orientation
 * @instance
 * @function resliceSeries
 * @param {Object} seriesData the original series data
 * @param {String} orientation the reslice orientation [coronal or sagittal]
 * @param {String} seriesId the series id
 * @returns {Promise} - Return a promise which will resolve when data is available
 */
export function resliceSeries(seriesData, orientation) {
  let reslicePromise = new Promise(resolve => {
    let reslicedSeries = {};
    let reslicedSeriesId = uuidv4();
    let reslicedMetaData = getReslicedMetadata(
      reslicedSeriesId,
      "axial",
      orientation,
      seriesData,
      "resliceLoader"
    );

    reslicedSeries.imageIds = reslicedMetaData.imageIds;
    reslicedSeries.instances = reslicedMetaData.instances;

    reslicedSeries.currentImageIdIndex = Math.floor(
      reslicedSeries.imageIds.length / 2
    );

    function computeReslice(seriesData, reslicedSeriesId, reslicedSeries) {
      let t0 = performance.now();
      let imageTracker = getLarvitarImageTracker();
      let manager = getLarvitarManager();
      each(reslicedSeries.imageIds, function (imageId) {
        reslicedSeries.instances[imageId].pixelData = getReslicedPixeldata(
          imageId,
          seriesData,
          reslicedSeries
        );
        imageTracker[imageId] = reslicedSeriesId;
      });
      larvitar_store.addSeriesIds(reslicedSeriesId, reslicedSeries.imageIds);
      reslicedSeries.numberOfImages = reslicedSeries.imageIds.length;
      reslicedSeries.seriesUID = reslicedSeriesId;
      reslicedSeries.seriesDescription = seriesData.seriesDescription;
      reslicedSeries.orientation = orientation;
      manager[reslicedSeriesId] = reslicedSeries;
      manager[seriesData.seriesUID][orientation] = reslicedSeriesId;
      let t1 = performance.now();
      console.log(`Call to resliceSeries took ${t1 - t0} milliseconds.`);
      resolve(reslicedSeries);
    }
    // reslice the data
    computeReslice(seriesData, reslicedSeriesId, reslicedSeries);
  });
  return reslicePromise;
}
