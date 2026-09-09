const USER_ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  EMPLOYEE: 'employee',
  REALTOR: 'realtor',
  CLIENT: 'client',
  COO: 'coo',
  CSMO: 'csmo',
  PRODUCT_MANAGER: 'product_manager',
  CUSTOMER_CARE: 'customer_care',
  MEDIA_TEAM: 'media_team',
  BRANCH_MANAGER: 'branch_manager',
  FRONT_DESK: 'front_desk',
};

const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
};

module.exports = { USER_ROLES, HTTP_STATUS };
