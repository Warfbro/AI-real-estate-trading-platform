const { CLOUD_COLLECTIONS, listingDataGateway, uploadImportImage } = require("../../utils/cloud");

module.exports = {
  CLOUD_COLLECTIONS,
  syncListingImportJob: listingDataGateway.syncListingImportJob,
  syncListing: listingDataGateway.syncListing,
  uploadImportImage
};
