"""业务异常。"""


class BusinessError(Exception):
    """规则不满足（容量、库存、状态流转等），对应 HTTP 400。"""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.message = message
        self.code = code or "BUSINESS_RULE"


class PermissionDenied(Exception):
    """角色无权操作，对应 HTTP 403。"""


class NotFound(Exception):
    """资源不存在，对应 HTTP 404。"""
