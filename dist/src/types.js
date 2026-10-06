/** 调用方可观察的设备状态。 */
export var DeviceStatus;
(function (DeviceStatus) {
    /** 待评估：规则或报告刚生效，异步评估尚未产出有效结论。设备保持隔离。 */
    DeviceStatus["PendingEvaluation"] = "pending_evaluation";
    /** 合规：当前规则版本 + 当前报告的有效评估结论为合规。 */
    DeviceStatus["Compliant"] = "compliant";
    /** 不合规：当前规则版本 + 当前报告的有效评估结论为不合规。设备保持隔离。 */
    DeviceStatus["NonCompliant"] = "non_compliant";
    /** 隔离：没有任何报告，或尚无任何有效评估结论。 */
    DeviceStatus["Isolated"] = "isolated";
})(DeviceStatus || (DeviceStatus = {}));
